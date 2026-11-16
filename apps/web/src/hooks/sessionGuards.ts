/**
 * Session rules the webview applies around Rust's answers (1.3.1 B1). Pure, so
 * they are tested without Tauri or Firebase (sessionGuards.test.ts).
 */

/** Was this error Rust refusing to end or clear a running session (H2)? */
export function isSessionRunningRefusal(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const text = err instanceof Error ? err.message : String(err);
  return text.startsWith(SESSION_RUNNING_PREFIX);
}

/** The start of the message Rust refuses with (integrity::SESSION_RUNNING). */
export const SESSION_RUNNING_PREFIX = "A session is running.";

/** What rearm_from_server takes: a session this PC started, as Firebase has it. */
export interface ServerSession {
  startedAt: number;
  endTime: number;
  objective: string | null;
  uid: string;
}

/**
 * The server session Rust should re-arm (M7), or null: this PC's own session,
 * still live in Firebase, while Rust has none.
 */
export function serverSessionToRearm(
  sessionState: unknown,
  deviceId: string,
  uid: string,
  now: number
): ServerSession | null {
  if (!sessionState || typeof sessionState !== "object") return null;
  const s = sessionState as Record<string, unknown>;
  if (s.isActive !== true || s.originDeviceId !== deviceId) return null;
  if (typeof s.startedAt !== "number" || typeof s.endTime !== "number") return null;
  if (s.endTime <= now) return null;
  return {
    startedAt: s.startedAt,
    endTime: s.endTime,
    objective: typeof s.objective === "string" ? s.objective : null,
    uid,
  };
}
