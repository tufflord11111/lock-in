import test from "node:test";
import assert from "node:assert/strict";
import { buildRules, sameRules, sanitizeDomain, PERMANENT_RULE_ID, SESSION_RULE_ID } from "./dnrRules.js";

test("sanitizeDomain reduces an entry to its domain", () => {
  assert.equal(sanitizeDomain("youtube.com"), "youtube.com");
  assert.equal(sanitizeDomain("https://www.YouTube.com/watch?v=1"), "youtube.com");
  assert.equal(sanitizeDomain("reddit.com/r/x"), "reddit.com");
  assert.equal(sanitizeDomain("bücher.de"), "xn--bcher-kva.de");
});

test("sanitizeDomain refuses what would reject the whole rule update", () => {
  for (const bad of ["discord.exe", "spotify", "", "   ", null, 7, "a b.com", "127.0.0.1", "http://"]) {
    assert.equal(sanitizeDomain(bad), null, String(bad));
  }
});

test("session rule only while locked, permanent rule always", () => {
  const lists = { sessionSites: ["youtube.com"], permanentSites: ["x.com"] };
  assert.deepEqual(buildRules({ ...lists, locked: true }).map((r) => r.id), [SESSION_RULE_ID, PERMANENT_RULE_ID]);
  assert.deepEqual(buildRules({ ...lists, locked: false }).map((r) => r.id), [PERMANENT_RULE_ID]);
});

test("rules redirect main and sub frames to the block page", () => {
  const [rule] = buildRules({ locked: true, sessionSites: ["www.youtube.com", "youtube.com", "notepad.exe"], permanentSites: [] });
  assert.deepEqual(rule.condition.requestDomains, ["youtube.com"]);
  assert.deepEqual(rule.condition.resourceTypes, ["main_frame", "sub_frame"]);
  assert.equal(rule.action.redirect.extensionPath, "/block.html");
});

test("an empty list produces no rule", () => {
  assert.deepEqual(buildRules({ locked: true, sessionSites: ["spotify"], permanentSites: [] }), []);
});

test("sameRules ignores order and notices a change", () => {
  const a = buildRules({ locked: true, sessionSites: ["a.com", "b.com"], permanentSites: ["c.com"] });
  const reversed = buildRules({ locked: true, sessionSites: ["b.com", "a.com"], permanentSites: ["c.com"] }).reverse();
  assert.ok(sameRules(a, reversed));
  assert.ok(!sameRules(a, buildRules({ locked: false, sessionSites: ["a.com"], permanentSites: ["c.com"] })));
});
