import test from "node:test";
import assert from "node:assert/strict";
import { browserFromBrands, BEAT_URL } from "./beat.js";

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
