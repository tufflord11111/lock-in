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
