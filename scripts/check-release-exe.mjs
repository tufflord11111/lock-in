/**
 * Fail if a release exe can read a dev/test switch.
 *
 * Release builds are compiled without the desktop crate's "dev-mode" feature, so
 * they never look for %APPDATA%\com.lockin.app\DEV_MODE or DEV_EXTENSION_ID. Any
 * user can create those files, and DEV_MODE shortens the Bail out fuse, so a
 * release exe that still names either file is a bypass and must not ship.
 *
 *   node scripts/check-release-exe.mjs [exe ...]
 *
 * It also fails an exe that still holds a build path under C:\Users\ (the
 * builder's Windows user name): release builds go through remap-build.mjs.
 *
 * With no arguments it checks target/release/app.exe (honouring CARGO_TARGET_DIR).
 * Searches both 8-bit and UTF-16LE text, any case. Exit 1 on any hit or missing file.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN = ["DEV_MODE", "DEV_EXTENSION_ID"];

const targetDir = process.env.CARGO_TARGET_DIR
  ? resolve(process.env.CARGO_TARGET_DIR)
  : join(root, "apps/desktop/src-tauri/target");
const exes = process.argv.length > 2 ? process.argv.slice(2) : [join(targetDir, "release/app.exe")];

let failed = false;
for (const exe of exes) {
  if (!existsSync(exe)) {
    console.error(`check-release-exe: ${exe} not found`);
    failed = true;
    continue;
  }
  const bytes = readFileSync(exe);
  const hits = [];
  for (const word of FORBIDDEN) {
    for (const [label, needle] of [
      ["ascii", Buffer.from(word, "latin1")],
      ["utf16", Buffer.from(word, "utf16le")],
    ]) {
      const at = bytes.indexOf(needle);
      if (at !== -1) hits.push(`${word} (${label}) at byte ${at}`);
    }
  }
  // Build paths: any case, both encodings.
  const lower = Buffer.from(bytes.toString("latin1").toLowerCase(), "latin1");
  let paths = 0;
  for (const needle of [Buffer.from("c:\\users\\", "latin1"), Buffer.from("c:\\users\\", "utf16le")]) {
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) paths++;
  }
  if (hits.length) {
    console.error(`check-release-exe: FAIL ${exe}\n  ${hits.join("\n  ")}\n  Was it built with --features dev-mode? Release builds must not be.`);
    failed = true;
  } else if (paths > 0) {
    console.error(`check-release-exe: FAIL ${exe}\n  ${paths} build path(s) under C:\\Users\\ — build through scripts/remap-build.mjs.`);
    failed = true;
  } else {
    console.log(`check-release-exe: ok ${exe} (no ${FORBIDDEN.join(", ")}, no C:\\Users\\ paths)`);
  }
}
process.exit(failed ? 1 : 0);
