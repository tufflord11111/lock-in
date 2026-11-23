/**
 * Sign out is refused while a session runs, as the tray's Quit is (Rust's
 * QUIT_REFUSED_MESSAGE). Signing out mid-session left Rust enforcing with no
 * account to record the session's end to, emptied the dashboard snapshot, and
 * on 2026-11-23 left the WebView unable to sync until its profile was reset.
 */
export const SIGN_OUT_DURING_SESSION = "End the session or Bail out first";

export function signOutAllowed(sessionActive: boolean): boolean {
  return !sessionActive;
}
