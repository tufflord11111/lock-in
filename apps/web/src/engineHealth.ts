import { reportWriteFailure } from "./writeFailures";

/**
 * Failures of the Rust enforcer's IPC commands.
 *
 * These used to go to console.warn only. A failed stop left apps being killed
 * until the session's original end time while the UI said it had ended; a
 * failed start showed an active session that nothing enforced; a failed
 * blocklist sync meant new blocks silently didn't apply. The "engine offline"
 * banner only ever reflected sync_lock_state.
 *
 * Now each failure raises an error toast and flips that banner (useOmniSync
 * listens). Toasts for the same command are rate-limited, since the blocklist
 * syncs re-fire on every change and a dead engine would otherwise flood them.
 */

const isTauri =
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

const TOAST_DEDUPE_MS = 60_000;
const lastToastAt = new Map<string, number>();

type Listener = () => void;
const listeners = new Set<Listener>();

export function reportEngineFailure(command: string, message: string, err: unknown): void {
  // In a plain browser there is no enforcer: invoke always fails, and that is
  // not a failure worth telling anyone about.
  if (!isTauri) {
    console.warn(`[Enforcer] ${command} — not running under Tauri:`, err);
    return;
  }
  console.error(`[Enforcer] ${command} failed:`, err);
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* never break the reporter */
    }
  }
  const now = Date.now();
  if (now - (lastToastAt.get(command) ?? 0) >= TOAST_DEDUPE_MS) {
    lastToastAt.set(command, now);
    reportWriteFailure(message, err);
  }
}

/** Subscribe to enforcer failures. Returns an unsubscribe function. */
export function onEngineFailure(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
