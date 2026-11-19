import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withMirrors, archivePattern, translateHost } from "./mirrors.js";
import { buildRules, SESSION_ARCHIVE_RULE_ID, SESSION_RULE_ID, sameRules } from "./dnrRules.js";

const MIRRORS = JSON.parse(readFileSync(new URL("./mirrors.json", import.meta.url), "utf8"));

test("the mirror list is data, with what the 1.3.1 brief names", () => {
  assert.equal(MIRRORS.version, 1);
  assert.ok(MIRRORS.bySite["youtube.com"].includes("youtube-nocookie.com"));
  assert.ok(MIRRORS.bySite["youtube.com"].includes("yewtu.be"), "Invidious");
  assert.equal(MIRRORS.translateGoog, true);
  assert.deepEqual(MIRRORS.archives, ["web.archive.org"]);
  const src = readFileSync(new URL("./mirrors.js", import.meta.url), "utf8");
  assert.ok(!src.includes("nocookie") && !src.includes("yewtu"), "no domains in the code");
});

test("blocking YouTube blocks youtube-nocookie and Invidious too", () => {
  const sites = withMirrors(["youtube.com"], MIRRORS);
  for (const d of ["youtube.com", "youtube-nocookie.com", "yewtu.be", "inv.nadeko.net"]) assert.ok(sites.includes(d), d);
  // m.youtube.com finds YouTube's mirrors through its parent.
  assert.ok(withMirrors(["m.youtube.com"], MIRRORS).includes("youtube-nocookie.com"));
  // Other sites don't bring YouTube's mirrors.
  assert.ok(!withMirrors(["reddit.com"], MIRRORS).includes("yewtu.be"));
});

test("any blocked site is blocked through translate.goog as well", () => {
  assert.equal(translateHost("youtube.com"), "youtube-com.translate.goog");
  assert.equal(translateHost("my-site.co.uk"), "my--site-co-uk.translate.goog");
  const sites = withMirrors(["reddit.com"], MIRRORS);
  for (const d of ["reddit-com.translate.goog", "www-reddit-com.translate.goog", "m-reddit-com.translate.goog"]) assert.ok(sites.includes(d), d);
  // translate.goog itself (other sites' translations) stays open.
  assert.ok(!sites.includes("translate.goog"));
});

test("a blocked site's pages in web.archive.org are blocked, others aren't", () => {
  const re = new RegExp(archivePattern(["youtube.com", "x.com"], MIRRORS), "i");
  for (const url of [
    "https://web.archive.org/web/20240101000000/https://www.youtube.com/watch?v=1",
    "https://web.archive.org/web/2024/youtube.com/",
    "http://web.archive.org/web/*/https://x.com",
    "https://web.archive.org/web/20240101000000/https%3A%2F%2Fm.youtube.com%2F",
  ]) assert.ok(re.test(url), url);
  for (const url of [
    "https://web.archive.org/web/2024/https://example.com/youtube.com",
    "https://web.archive.org/web/2024/https://notyoutube.com/",
    "https://web.archive.org/",
    "https://www.youtube.com.evil.example/",
  ]) assert.ok(!re.test(url), url);
  assert.equal(archivePattern([], MIRRORS), null);
});

test("the rules carry the mirrors and the archive pattern only while locked", () => {
  const sessionSites = withMirrors(["youtube.com"], MIRRORS);
  const sessionArchive = archivePattern(["youtube.com"], MIRRORS);
  const locked = buildRules({ locked: true, sessionSites, permanentSites: [], sessionArchive });
  assert.deepEqual(locked.map((r) => r.id), [SESSION_RULE_ID, SESSION_ARCHIVE_RULE_ID]);
  assert.ok(locked[0].condition.requestDomains.includes("youtube-nocookie.com"));
  assert.equal(locked[1].condition.regexFilter, sessionArchive);
  assert.deepEqual(buildRules({ locked: false, sessionSites, permanentSites: [], sessionArchive }), []);
  // A changed pattern is a change.
  const other = buildRules({ locked: true, sessionSites, permanentSites: [], sessionArchive: archivePattern(["x.com"], MIRRORS) });
  assert.ok(!sameRules(locked, other));
});
