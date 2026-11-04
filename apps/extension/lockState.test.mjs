import test from "node:test";
import assert from "node:assert/strict";
import { isLocked } from "./lockState.js";
import { buildRules, SESSION_RULE_ID, PERMANENT_RULE_ID } from "./dnrRules.js";

const SITES = ["youtube.com"];
const ids = (state, now, permanentSites = []) =>
  buildRules({ locked: isLocked(state, now), sessionSites: SITES, permanentSites }).map((r) => r.id);

test("a running session locks and installs the session rule", () => {
  const state = { focusActive: true, sessionEndTime: 2_000 };
  assert.equal(isLocked(state, 1_000), true);
  assert.deepEqual(ids(state, 1_000), [SESSION_RULE_ID]);
});

test("session ended, offline: nothing arrives from Firebase, and the clock alone clears it", () => {
  const stillSaysActive = { focusActive: true, sessionEndTime: 2_000 };
  assert.equal(isLocked(stillSaysActive, 2_000), false);
  assert.deepEqual(ids(stillSaysActive, 2_000), []);
});

test("session ended, online: Firebase clears it", () => {
  const cleared = { focusActive: false, sessionEndTime: null };
  assert.equal(isLocked(cleared, 2_000), false);
  assert.deepEqual(ids(cleared, 2_000), []);
});

test("the bug: hours of app uptime today don't lock anything", () => {
  // What 1.2.5 saved at 442 minutes, with no session running.
  const saved = { focusActive: false, sessionEndTime: null, manualLock: false, thresholdReached: true };
  assert.equal(isLocked(saved, 2_000), false);
  assert.deepEqual(ids(saved, 2_000), []);
});

test("permanent blocks stay after a session ends", () => {
  const ended = { focusActive: true, sessionEndTime: 2_000 };
  assert.deepEqual(ids(ended, 3_000, ["x.com"]), [PERMANENT_RULE_ID]);
});

test("an emergency unlock lifts a running session, then it comes back", () => {
  const state = { focusActive: true, sessionEndTime: 10_000, unlockExpiry: 5_000 };
  assert.equal(isLocked(state, 4_000), false);
  assert.equal(isLocked(state, 5_000), true);
});

test("a session with no end time locks until it's cleared", () => {
  assert.equal(isLocked({ focusActive: true, sessionEndTime: null }, 1_000), true);
});
