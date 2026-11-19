// One Web Guard version per release: the one uploaded to the Chrome Web Store.
// manifest.json is what Chrome reads (and what the beat reports to the desktop
// app); package.json and the store submission sheet must say the same.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8").replace(/^﻿/, "");
const manifest = JSON.parse(read("./manifest.json"));
const pkg = JSON.parse(read("./package.json"));
const sheet = read("./STORE_SUBMISSION.md");

test("manifest and package carry the same version", () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.version, manifest.version);
});

test("the store submission sheet names that version, and only that one as the upload", () => {
  const v = manifest.version;
  assert.equal(sheet.split(/\r?\n/)[0], `# Chrome Web Store submission — Lock-In Web Guard ${v}`);
  assert.match(sheet, new RegExp(`\\| Version \\| ${v.replace(/\./g, "\\.")} \\|`));
  assert.match(sheet, new RegExp(`lock-in-extension-v${v.replace(/\./g, "\\.")}\\.zip`));
  const zips = [...sheet.matchAll(/lock-in-extension-v([\d.]+)\.zip/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(zips)], [v]);
  assert.match(sheet, new RegExp(`\\*\\*${v.replace(/\./g, "\\.")}\\*\\* —`), "a what's-new entry for it");
});
