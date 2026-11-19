import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 1.3.1 M4 / L1 — local approval of blocks added from elsewhere, webview side.
// Rust decides what is approved (integrity_tests.rs m4_*, l1_*); the webview must
// not vouch for anything from Firebase, and must approve only what it showed.
const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("M4: 'added on this PC' is Rust's to know", () => {
  const app = src("../App.tsx");
  const registry = src("../screens/BlockRegistry.tsx");

  it("no longer reads blockedApps_meta or sends an approved list", () => {
    expect(app).not.toMatch(/onValue\([^)]*blockedApps_meta/);
    expect(app).not.toMatch(/approvedList/);
    expect(app).not.toMatch(/lockin_exe_migrated_v1/);
  });

  it("never tells Rust a Firebase sync is local", () => {
    for (const s of [app, registry]) expect(s).not.toMatch(/fromRemote/);
  });

  it("tells Rust before writing a session app it adds", () => {
    for (const s of [app.slice(app.indexOf("const handleAddExe")), registry.slice(registry.indexOf("const makeExeSession"))]) {
      const note = s.indexOf('invoke("note_local_exe"');
      const write = s.indexOf("blockedApps/${");
      expect(note).toBeGreaterThan(-1);
      expect(note).toBeLessThan(write);
    }
  });
});

describe("L1: approve and reject name what the banner shows", () => {
  const banner = src("../components/PendingPermanentBanner.tsx");
  it.each([
    ["confirm_pending_exe", "exePending"],
    ["confirm_pending_permanent", "permPending"],
    ["reject_pending_exe", "exePending"],
    ["reject_pending_permanent", "permPending"],
  ])("%s gets the shown %s", (cmd, list) => {
    expect(banner).toContain(`invoke("${cmd}", { names: ${list} })`);
    expect(banner).not.toContain(`invoke("${cmd}")`);
  });
});
