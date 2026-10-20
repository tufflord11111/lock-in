/**
 * Stage the MSIX payload.
 *
 * The cargo binary is `app.exe` ([package] name = "app"), and only the Tauri
 * bundler renames it to Lock-In.exe inside the MSI/NSIS payload. The MSIX
 * build does not run the bundler, so the rename happens here — and it is not
 * cosmetic:
 *
 *   * protected_process_names() (lib.rs) adds current_exe()'s file stem to the
 *     protected list, so a mis-named exe would leave Lock-In killable by its
 *     own enforcer;
 *   * get_running_apps() filters a hard-coded "lock-in" out of the picker.
 *
 * Only the exe and a WebView2 loader DLL if one is actually emitted are
 * staged. target/release also holds app_lib.dll and a large tree of build
 * intermediates; none of that belongs in the package.
 */
import { existsSync, mkdirSync, rmSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = join(root, "apps/desktop/src-tauri/target/release");
const distDir = join(root, "apps/desktop/src-tauri/dist");

const exeSrc = join(releaseDir, "app.exe");
if (!existsSync(exeSrc)) {
  console.error(
    `stage-msix: ${exeSrc} not found.\n` +
      "Build the store variant first:\n" +
      "  cargo build --release --no-default-features --features store"
  );
  process.exit(1);
}

// Wipe rather than overwrite, so a file dropped by an earlier run can never
// ride along into the package unnoticed.
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const staged = [];
const stage = (from, to) => {
  copyFileSync(from, join(distDir, to));
  staged.push([to, statSync(from).size]);
};

stage(exeSrc, "Lock-In.exe");

// Tauri v2 links the WebView2 loader statically, so normally there is nothing
// here. Copy it only if this toolchain actually emitted one.
for (const name of readdirSync(releaseDir)) {
  if (/^WebView2Loader\.dll$/i.test(name)) stage(join(releaseDir, name), name);
}

for (const [name, size] of staged) {
  console.log(`staged ${name.padEnd(24)} ${(size / 1024).toFixed(0)} KB`);
}
console.log(`stage-msix: ${staged.length} file(s) in ${distDir}`);
