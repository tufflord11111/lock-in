// Whether session blocking applies right now. One decision, used by the worker and
// the popup, so they can't disagree. No chrome.* here, so it can be tested.

/**
 * Decided from the clock every time, never stored: nothing changes in Firebase when
 * a session's endTime passes, and it must lift offline too.
 *
 * A session with no endTime locks for as long as focusActive is true.
 */
export function isLocked({ manualLock, focusActive, sessionEndTime, unlockExpiry }, now) {
  if (typeof unlockExpiry === "number" && now < unlockExpiry) return false;
  const sessionLive =
    focusActive === true && (typeof sessionEndTime !== "number" || now < sessionEndTime);
  return manualLock === true || sessionLive;
}

/**
 * Does a sign-out from the popup clear this account's blocks now? Only when
 * nothing is locking (1.3.1 L5). During a session the popup may still sign
 * out, but the session's blocks stay until it ends; the worker clears them then.
 */
export function signOutClears(state, now) {
  return !isLocked(state, now);
}
