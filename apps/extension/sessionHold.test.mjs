import test from "node:test";
import assert from "node:assert/strict";
import { nextHold, holdUntil, FUSE_MIN_MS } from "./sessionHold.js";
import { isLocked } from "./lockState.js";

const MIN = 60_000;
const live = (over = {}) => ({
  config: { focusActive: true },
  sessionState: { isActive: true, guard: 2, startedAt: 0, endTime: 30 * MIN, ...over },
});
const off = { config: { focusActive: false }, sessionState: { isActive: false } };
/** What the worker decides from: the raw flags plus the hold. */
const locked = (data, hold, now) =>
  isLocked({
    focusActive: data.config?.focusActive === true,
    sessionEndTime: typeof data.sessionState?.endTime === "number" ? data.sessionState.endTime : null,
    holdUntil: holdUntil(hold),
  }, now);

test("a raw focusActive:false write mid-session doesn't unlock a guarded session", () => {
  let hold = nextHold(null, live(), 1 * MIN);
  hold = nextHold(hold, off, 10 * MIN);
  assert.equal(locked(off, hold, 10 * MIN), true);
  assert.equal(locked(off, hold, 29 * MIN), true);
  assert.equal(locked(off, hold, 30 * MIN), false, "lifts at the session's endTime");
});

test("isLocked:false, sessionState removed, or the whole node gone: still held until endTime", () => {
  let hold = nextHold(null, live(), 1 * MIN);
  for (const data of [{ config: { focusActive: false }, isLocked: false }, { config: { focusActive: true } }, {}]) {
    hold = nextHold(hold, data, 5 * MIN);
    assert.equal(locked(data, hold, 5 * MIN), true, JSON.stringify(data));
  }
});

test("an earlier endTime written later doesn't shorten the hold", () => {
  let hold = nextHold(null, live(), 1 * MIN);
  hold = nextHold(hold, live({ endTime: 2 * MIN }), 1.5 * MIN);
  assert.equal(holdUntil(hold), 30 * MIN);
});

test("a NEW session can start any time, and one ending later extends the hold", () => {
  let hold = nextHold(null, off, 0);
  assert.equal(hold, null);
  hold = nextHold(hold, live({ endTime: 20 * MIN }), 1 * MIN);
  assert.equal(holdUntil(hold), 20 * MIN);
  hold = nextHold(hold, live({ startedAt: 5 * MIN, endTime: 50 * MIN }), 5 * MIN);
  assert.equal(holdUntil(hold), 50 * MIN);
  // After the first ends, a new one is held on its own.
  let h2 = nextHold(nextHold(null, live({ endTime: 10 * MIN }), 0), off, 11 * MIN);
  assert.equal(holdUntil(h2), null, "the old hold has lifted");
  h2 = nextHold(h2, live({ startedAt: 12 * MIN, endTime: 40 * MIN }), 12 * MIN);
  assert.equal(holdUntil(h2), 40 * MIN);
});

test("Bail out: lifts when the fuse burns down, not before", () => {
  let hold = nextHold(null, live(), 1 * MIN);
  hold = nextHold(hold, live({ bailoutEnd: 15 * MIN }), 10 * MIN);
  hold = nextHold(hold, off, 12 * MIN); // the fuse burns; the desktop clears the flags
  assert.equal(locked(off, hold, 14.9 * MIN), true);
  assert.equal(locked(off, hold, 15 * MIN), false);
});

test("a fuse shorter than 4.5 min from when it was last seen without one is stretched", () => {
  let hold = nextHold(null, live(), 1 * MIN);
  hold = nextHold(hold, live(), 10 * MIN);
  hold = nextHold(hold, live({ bailoutEnd: 10 * MIN + 1000 }), 10 * MIN);
  assert.equal(holdUntil(hold), 10 * MIN + FUSE_MIN_MS);
});

test("a fuse first seen late (browser was closed) isn't stretched", () => {
  let hold = nextHold(null, live(), 1 * MIN);
  hold = nextHold(hold, live({ bailoutEnd: 9 * MIN }), 12 * MIN);
  assert.equal(holdUntil(hold), 9 * MIN);
});

test("a fuse can't be moved later to keep, or earlier to escape, once seen", () => {
  let hold = nextHold(null, live({ bailoutEnd: 10 * MIN }), 1 * MIN);
  hold = nextHold(hold, live({ bailoutEnd: 2 * MIN }), 1.5 * MIN);
  assert.equal(holdUntil(hold), 10 * MIN);
});

test("sessions without guard (started by desktop 1.3.0) keep the old behaviour", () => {
  const legacy = { config: { focusActive: true }, sessionState: { isActive: true, endTime: 30 * MIN } };
  let hold = nextHold(null, legacy, 1 * MIN);
  assert.equal(hold, null);
  hold = nextHold(hold, off, 5 * MIN);
  assert.equal(locked(off, hold, 5 * MIN), false, "1.3.0's Bail out still unlocks sites");
});

test("a session seen only after its endTime holds nothing", () => {
  assert.equal(nextHold(null, live({ endTime: 5 * MIN }), 6 * MIN), null);
});

test("the hold survives being stored and read back (worker eviction)", () => {
  const hold = nextHold(null, live({ bailoutEnd: 20 * MIN }), 1 * MIN);
  const back = JSON.parse(JSON.stringify(hold));
  assert.equal(holdUntil(back), 20 * MIN);
  assert.equal(holdUntil({ junk: true }), null);
  assert.equal(holdUntil("x"), null);
});

test("an emergency unlock still lifts it", () => {
  const hold = nextHold(null, live(), 1 * MIN);
  assert.equal(isLocked({ focusActive: false, holdUntil: holdUntil(hold), unlockExpiry: 20 * MIN }, 10 * MIN), false);
});

test("the worker decides with the hold, keeps it across eviction and account switches", async () => {
  const { readFileSync } = await import("node:fs");
  const bg = readFileSync(new URL("./background.js", import.meta.url), "utf8");
  assert.match(bg, /sessionHold = nextHold\(sessionHold, data, Date\.now\(\)\);/);
  assert.match(bg, /unlockExpiry, holdUntil: holdUntil\(sessionHold\) \};/);
  assert.match(bg, /if \(holdUntil\(g\.sessionHold\) !== null\) sessionHold = g\.sessionHold;/);
  assert.match(bg, /holdUntil: holdUntil\(sessionHold\),/);
  assert.match(bg, /if \(held\) \{\s+sessionHold = held;/);
});
