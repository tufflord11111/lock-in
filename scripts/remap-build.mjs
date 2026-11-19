/**
 * Run a build with this PC's home folders stripped from the binary.
 *
 * rustc writes source paths into panic messages and debug info. Crates from
 * the registry live under %USERPROFILE%\.cargo, so every release exe carried
 * "C:\Users\<name>\.cargo\registry\..." hundreds of times: the Windows user
 * name of whoever built it. --remap-path-prefix rewrites those paths at
 * compile time.
 *
 * Not in .cargo/config.toml: rustflags there can't read the home folder, and
 * writing it out would commit the very user name this removes. So the flags
 * are computed here and passed in CARGO_ENCODED_RUSTFLAGS, which applies to
 * every rustc call cargo makes (tauri build included).
 *
 *   node scripts/remap-build.mjs <command> [args...]
 *
 * check-release-exe.mjs then fails any exe that still contains "C:\Users\".
 */
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();
const cargoHome = process.env.CARGO_HOME || join(home, ".cargo");
const rustupHome = process.env.RUSTUP_HOME || join(home, ".rustup");

// When several match, rustc applies the last: most specific last.
const flags = [
  `--remap-path-prefix=${home}=home`,
  `--remap-path-prefix=${rustupHome}=rustup`,
  `--remap-path-prefix=${cargoHome}=cargo`,
];
const existing = process.env.CARGO_ENCODED_RUSTFLAGS
  ? process.env.CARGO_ENCODED_RUSTFLAGS.split("\x1f")
  : (process.env.RUSTFLAGS || "").split(" ").filter(Boolean);
const env = { ...process.env, CARGO_ENCODED_RUSTFLAGS: [...existing, ...flags].join("\x1f") };
delete env.RUSTFLAGS;

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error("usage: node scripts/remap-build.mjs <command> [args...]");
  process.exit(2);
}
console.log(`remap-build: stripping ${cargoHome}, ${rustupHome} and ${home} from the build`);
const r = spawnSync(cmd, args, { stdio: "inherit", shell: true, env });
process.exit(r.status ?? 1);
