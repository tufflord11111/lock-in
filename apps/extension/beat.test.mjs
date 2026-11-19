import test from "node:test";
import assert from "node:assert/strict";
import { browserFromBrands, BEAT_URL, beatBody, WINDOW_TYPES } from "./beat.js";

const brands = (...names) => names.map((brand) => ({ brand, version: "130" }));

test("names the browsers it can identify", () => {
  assert.equal(browserFromBrands(brands("Not?A_Brand", "Chromium", "Google Chrome")), "chrome");
  assert.equal(browserFromBrands(brands("Microsoft Edge", "Chromium")), "edge");
  assert.equal(browserFromBrands(brands("Brave", "Chromium")), "brave");
  assert.equal(browserFromBrands(brands("Chromium"), true), "brave");
});

test("anything else is chromium, which allows nothing", () => {
  assert.equal(browserFromBrands(brands("Chromium")), "chromium");
  assert.equal(browserFromBrands(brands("Opera", "Chromium")), "chromium");
  assert.equal(browserFromBrands(undefined), "chromium");
});

test("beats go to loopback only", () => {
  assert.equal(new URL(BEAT_URL).hostname, "127.0.0.1");
});

test("the beat carries this profile's id and how many windows Web Guard sees", () => {
  const body = beatBody({ browser: "chrome", version: "1.2.7", incognitoAllowed: true, uid: "u1", profileId: "p1", windows: 3, locked: true, hostAccess: true });
  assert.deepEqual(body, { locked: true, hostAccess: true, browser: "chrome", version: "1.2.7", incognitoAllowed: true, uid: "u1", profileId: "p1", windows: 3 });
  const bad = beatBody({ browser: "edge", version: "1.2.7", incognitoAllowed: undefined, uid: undefined, profileId: 5, windows: -1 });
  assert.equal(bad.incognitoAllowed, false);
  assert.equal(bad.uid, null);
  assert.equal(bad.profileId, null);
  assert.equal(bad.windows, null, "a count it can't vouch for is left out, not guessed");
  assert.equal(bad.locked, false);
  assert.equal(bad.hostAccess, false, "unknown site access is reported as none");
});

test("Web Guard counts every window type it can see", () => {
  for (const t of ["normal", "popup", "app", "devtools"]) assert.ok(WINDOW_TYPES.includes(t), t);
});
