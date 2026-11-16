/**
 * What the main window does when Rust emits "enforcer-stood-down". Pure, so the
 * rule is tested without Tauri (standDown.test.ts).
 *
 * "end-session" runs endSession (this session ending on time or on its fuse),
 * "reset" only resets the session UI, "none" does nothing, and "ignore" means
 * Rust says it is still armed, so the event is not acted on at all.
 */
export type StandDownAction = "end-session" | "reset" | "none" | "ignore";

export interface LocalSession {
  /** A session started or adopted here that hasn't ended yet. */
  sessionLive: boolean;
  /** The session UI shows a session running. */
  isActive: boolean;
}

/** Rust's state as get_enforcer_state reports it, or null if it couldn't be read. */
export interface RustSession {
  focus_active: boolean;
}

export function standDownAction(reason: string, local: LocalSession, rust: RustSession | null): StandDownAction {
  // The event alone never ends a session (1.3.1 L7): Rust's own state decides.
  // Armed, or unreadable, means the event is stale or not Rust's.
  if (rust === null || rust.focus_active) return "ignore";
  if ((reason === "bailout-expired" || reason === "deadline-expired") && local.sessionLive) return "end-session";
  if (local.isActive) return "reset";
  return "none";
}
