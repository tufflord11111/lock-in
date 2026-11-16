import { describe, expect, it } from "vitest";
import { standDownAction } from "./standDown";
import { isSessionRunningRefusal, serverSessionToRearm } from "./sessionGuards";
import { heldSites } from "../screens/heldBlocks";

// 1.3.1 B1 — session integrity, webview side.

describe("L7: the main window acts on enforcer-stood-down only when Rust agrees", () => {
  const live = { sessionLive: true, isActive: true };

  it("never ends a session on the event alone: Rust still armed means ignore", () => {
    for (const reason of ["deadline-expired", "bailout-expired", "clear-all-blocks", "session-ended-local"]) {
      expect(standDownAction(reason, live, { focus_active: true })).toBe("ignore");
    }
  });

  it("ignores the event when Rust's state can't be read", () => {
    expect(standDownAction("deadline-expired", live, null)).toBe("ignore");
  });

  it("acts as before once Rust confirms it stood down", () => {
    const idle = { focus_active: false };
    expect(standDownAction("deadline-expired", live, idle)).toBe("end-session");
    expect(standDownAction("bailout-expired", live, idle)).toBe("end-session");
    expect(standDownAction("clear-all-blocks", live, idle)).toBe("reset");
    expect(standDownAction("deadline-expired", { sessionLive: false, isActive: false }, idle)).toBe("none");
  });
});

describe("H2: Rust's refusal to end a running session is recognised", () => {
  it("knows the refusal", () => {
    expect(isSessionRunningRefusal("A session is running. Use Bail out to end it early.")).toBe(true);
    expect(isSessionRunningRefusal(new Error("A session is running. Use Bail out to end it early."))).toBe(true);
  });
  it("treats anything else as an engine failure", () => {
    expect(isSessionRunningRefusal("Mutex lock failed: poisoned")).toBe(false);
    expect(isSessionRunningRefusal(undefined)).toBe(false);
  });
});

describe("M7: this PC's session, still live in Firebase, is re-armed", () => {
  const NOW = 1_800_000_000_000;
  const state = { isActive: true, startedAt: NOW - 60_000, endTime: NOW + 60_000, objective: "Write", originDeviceId: "dev1" };

  it("re-arms this device's live session", () => {
    expect(serverSessionToRearm(state, "dev1", "uid1", NOW)).toEqual({
      startedAt: NOW - 60_000,
      endTime: NOW + 60_000,
      objective: "Write",
      uid: "uid1",
    });
  });

  it("leaves another device's, an ended, an expired or a malformed session alone", () => {
    expect(serverSessionToRearm(state, "dev2", "uid1", NOW)).toBeNull();
    expect(serverSessionToRearm({ ...state, isActive: false }, "dev1", "uid1", NOW)).toBeNull();
    expect(serverSessionToRearm({ ...state, endTime: NOW }, "dev1", "uid1", NOW)).toBeNull();
    expect(serverSessionToRearm({ ...state, startedAt: undefined }, "dev1", "uid1", NOW)).toBeNull();
    expect(serverSessionToRearm(null, "dev1", "uid1", NOW)).toBeNull();
  });
});

describe("H1: the Blocks tab shows sites removed mid-session as held", () => {
  it("lists what the session started with that the lists no longer show", () => {
    const atStart = ["youtube.com", "tiktok.com", "reddit.com", "discord.exe"];
    expect(heldSites(atStart, ["tiktok.com"])).toEqual(["reddit.com", "youtube.com"]);
  });
  it("lists nothing with no session or nothing removed", () => {
    expect(heldSites(undefined, ["tiktok.com"])).toEqual([]);
    expect(heldSites(["tiktok.com"], ["tiktok.com", "x.com"])).toEqual([]);
  });
});
