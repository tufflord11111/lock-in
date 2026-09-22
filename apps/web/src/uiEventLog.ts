import { invoke } from "@tauri-apps/api/core";

/**
 * Append-only trail of UI events that leave no other trace — a toast nobody
 * saw, a write that sat queued offline. Written by Rust (append_ui_event) to
 * %APPDATA%\com.lockin.app\ui-events.log; the names must match its allowlist.
 */
export type UiEvent =
  | "session-end-timeout-offline"
  | "session-end-timeout-connected"
  | "session-end-acked"
  | "reconcile-write"
  | "name-repair";

const isTauri =
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

/** Fire-and-forget. A logging failure must never touch the caller's path. */
export function logUiEvent(event: UiEvent, uid: string | undefined): void {
  if (!isTauri) return;
  invoke("append_ui_event", { event, uidPrefix: (uid ?? "").slice(0, 6) }).catch(
    (err) => console.warn(`[LOCK-IN] ui-events.log append failed (${event}):`, err)
  );
}
