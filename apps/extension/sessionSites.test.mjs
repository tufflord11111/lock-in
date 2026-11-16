import test from "node:test";
import assert from "node:assert/strict";
import { sessionSiteList, permanentSiteList, freezeSessionSites, effectiveSites } from "./sessionSites.js";

// 1.3.1 B1 / H1: a running session's site lists are frozen. Additions apply at
// once; removals (defaults, custom, permanent) wait for the session's end.

const DEFAULTS = ["tiktok.com", "youtube.com", "netflix.com"];
const START = 1_000_000;
const END = START + 25 * 60_000;
const live = { focusActive: true, endTime: END };

/** The snapshot the desktop leaves at session start. */
const atStart = {
  customBlocks: { reddit_com: "reddit.com" },
  permanentBlocks: { x_com: "x.com" },
  sessionState: { isActive: true, endTime: END, blockedUrls: ["tiktok.com", "youtube.com", "netflix.com", "reddit.com", "x.com"] },
};

/** Run the worker's snapshot handling over a series of snapshots. */
function enforceAfter(snapshots, now) {
  let frozen = null;
  let current = null;
  for (const [data, at] of snapshots) {
    current = { sites: sessionSiteList(DEFAULTS, data), permanent: permanentSiteList(data) };
    frozen = freezeSessionSites(frozen, current, live, at);
  }
  return effectiveSites(current, frozen, now);
}

test("H1: a default removed mid-session stays blocked: the session's blockedUrls ignore removedDefaults", () => {
  const removed = { ...atStart, removedDefaults: ["youtube.com"] };
  assert.ok(sessionSiteList(DEFAULTS, removed).includes("youtube.com"));
});

test("H1: a custom site removed mid-session stays blocked until the session ends", () => {
  const removed = { ...atStart, customBlocks: {}, sessionState: { ...atStart.sessionState, blockedUrls: [] } };
  const lists = enforceAfter([[atStart, START], [removed, START + 60_000]], START + 120_000);
  assert.ok(lists.sites.includes("reddit.com"));
});

test("H1: a permanent site removed mid-session stays blocked until the session ends", () => {
  const removed = { ...atStart, permanentBlocks: {} };
  const lists = enforceAfter([[atStart, START], [removed, START + 60_000]], START + 120_000);
  assert.ok(lists.permanent.includes("x.com"));
});

test("H1: once the session ends the removals apply, with no new snapshot needed", () => {
  const removed = { ...atStart, customBlocks: {}, permanentBlocks: {}, removedDefaults: ["youtube.com"], sessionState: { isActive: false } };
  const lists = enforceAfter([[atStart, START], [removed, START + 60_000]], END);
  assert.ok(!lists.sites.includes("reddit.com"));
  assert.ok(!lists.sites.includes("youtube.com"));
  assert.ok(!lists.permanent.includes("x.com"));
});

test("H1: a site added mid-session is blocked at once", () => {
  const added = { ...atStart, customBlocks: { ...atStart.customBlocks, twitch_tv: "twitch.tv" } };
  const lists = enforceAfter([[atStart, START], [added, START + 60_000]], START + 120_000);
  assert.ok(lists.sites.includes("twitch.tv"));
});

test("H1: no session, nothing held: a removal applies at once", () => {
  let frozen = freezeSessionSites(null, { sites: ["reddit.com"], permanent: ["x.com"] }, { focusActive: false, endTime: null }, START);
  assert.equal(frozen, null);
  const lists = effectiveSites({ sites: [], permanent: [] }, frozen, START);
  assert.deepEqual(lists, { sites: [], permanent: [] });
});

test("H1: a new session starts a new hold; the last one's lists don't carry over", () => {
  const first = freezeSessionSites(null, { sites: ["reddit.com"], permanent: [] }, live, START);
  const next = freezeSessionSites(first, { sites: ["twitch.tv"], permanent: [] }, { focusActive: true, endTime: END + 60 * 60_000 }, END + 60_000);
  const lists = effectiveSites({ sites: ["twitch.tv"], permanent: [] }, next, END + 120_000);
  assert.deepEqual(lists.sites, ["twitch.tv"]);
});
