// Once Web Guard has seen a session started by desktop 1.3.1 (sessionState.guard 2),
// it keeps blocking until that session's endTime, or until its Bail out fuse has
// burned down, whatever the account's own token writes to focusActive, isLocked
// or sessionState meanwhile (1.3.1 B2). A new session can start at any time.
// Sessions without guard (desktop 1.3.0) are not held: their Bail out writes no
// fuse, so holding them would keep sites blocked after a real Bail out.
// No chrome.* here, so it can be tested.

/** Shortest fuse believed from when the session was last seen without one (the rules allow 30 s of slack). */
export const FUSE_MIN_MS = 5 * 60_000 - 30_000;

/** When the hold lifts (epoch ms), or null if there is none. */
export function holdUntil(hold) {
  if (!hold || typeof hold !== "object" || typeof hold.endTime !== "number") return null;
  return typeof hold.bailoutEnd === "number" ? Math.min(hold.endTime, hold.bailoutEnd) : hold.endTime;
}

/**
 * The hold after a users/{uid} snapshot. `prev` is the hold so far (or null).
 * Hold shape: { endTime, bailoutEnd, seenNoFuseAt }, all epoch ms or null.
 */
export function nextHold(prev, data, now) {
  const kept = holdUntil(prev) !== null && now < holdUntil(prev) ? prev : null;
  const s = data?.sessionState;
  const guarded =
    s && s.guard === 2 && s.isActive === true && typeof s.endTime === "number" && now < s.endTime;
  if (!guarded) return kept;

  const fuse = typeof s.bailoutEnd === "number" ? s.bailoutEnd : null;
  if (!kept) {
    return { endTime: s.endTime, bailoutEnd: fuse, seenNoFuseAt: fuse === null ? now : null };
  }
  // Never shorter: an earlier endTime or a moved fuse is ignored.
  const endTime = Math.max(kept.endTime, s.endTime);
  if (typeof kept.bailoutEnd === "number") return { ...kept, endTime };
  if (fuse === null) return { endTime, bailoutEnd: null, seenNoFuseAt: now };
  const bailoutEnd =
    typeof kept.seenNoFuseAt === "number" ? Math.max(fuse, kept.seenNoFuseAt + FUSE_MIN_MS) : fuse;
  return { endTime, bailoutEnd, seenNoFuseAt: null };
}

/**
 * The hold after the desktop app's reply to a beat (1.3.1). The app on this PC
 * says whether its own session is live, so a Web Guard that never heard of it
 * from Firebase (blocked, offline, or the account's token writing focusActive
 * false) blocks anyway. Same rules as nextHold: never shorter, a moved fuse is
 * ignored. A reply saying "no session" lifts nothing early.
 */
export function nextDesktopHold(prev, reply, now) {
  const s = reply?.session;
  if (!s || s.active !== true || typeof s.endTime !== "number") {
    return holdUntil(prev) !== null && now < holdUntil(prev) ? prev : null;
  }
  const sessionState = { guard: 2, isActive: true, endTime: s.endTime };
  if (typeof s.bailoutEnd === "number") sessionState.bailoutEnd = s.bailoutEnd;
  return nextHold(prev, { sessionState }, now);
}

/** The later of two holds' ends, or null if neither holds. */
export function laterHoldUntil(a, b) {
  const ua = holdUntil(a);
  const ub = holdUntil(b);
  if (ua === null) return ub;
  if (ub === null) return ua;
  return Math.max(ua, ub);
}
