import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SIGN_OUT_DURING_SESSION, signOutAllowed } from "./signOutGuard";
import { REQUIRED_BEFORE_WRITE, SnapshotDraft, snapshotWritable } from "./snapshotGate";
import { CHECK_MS, MIN_GAP_MS, STUCK_MS, WATCHDOG_START, watchdogStep, type WatchdogState } from "./syncWatchdog";
import { emptySnapshot, type Snapshot } from "./snapshot";

// 1.3.1, 2026-11-23: Sign out pressed during a running session, then sign-in,
// left this PC unable to sync until its WebView profile was reset. Three fixes.
const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const UID = "jLDrBTLQ05YlsCZdQ1r6kZi4EaY2";

function goodSnapshot(): Snapshot {
  return {
    ...emptySnapshot(UID),
    savedAt: 1,
    handle: "PARROTTEST",
    config: { email: "t@example.com", onboardingComplete: true, userName: "PARROTTEST" },
    blockedApps: ["notepad.exe"],
    blockedAppsRaw: { a: "notepad.exe" },
  };
}

describe("fix 1: Sign out is refused while a session runs", () => {
  const app = src("./App.tsx");

  it("is allowed only with no session, and says why as tray Quit does", () => {
    expect(signOutAllowed(false)).toBe(true);
    expect(signOutAllowed(true)).toBe(false);
    expect(SIGN_OUT_DURING_SESSION).toBe("End the session or Bail out first");
  });

  it("both header buttons are disabled with the reason, and nothing calls logout unguarded", () => {
    expect(app).not.toMatch(/onClick=\{logout\}|onLogout=\{logout\}/);
    const buttons = [...app.matchAll(/onClick=\{guardedLogout\}\n\s+disabled=\{!signOutAllowed\(isActive\)\}\n\s+title=\{signOutAllowed\(isActive\) \? undefined : SIGN_OUT_DURING_SESSION\}/g)];
    expect(buttons).toHaveLength(2);
  });

  it("the guard itself refuses with the reason before calling logout", () => {
    const guard = /const guardedLogout = useCallback\(\(\) => \{([\s\S]*?)\}, \[isActive, logout\]\);/.exec(app)![1];
    expect(guard.indexOf("reportWriteFailure(SIGN_OUT_DURING_SESSION")).toBeGreaterThan(-1);
    expect(guard.indexOf("return;")).toBeLessThan(guard.indexOf("logout()"));
  });
});

describe("fix 2: the snapshot writer waits for config and blockedApps, and never writes an empty config", () => {
  /** A run that started from this account's good snapshot and has heard config and blockedApps. */
  function heardBoth(patchBlocked?: (s: Snapshot) => void): SnapshotDraft {
    const draft = new SnapshotDraft(goodSnapshot());
    draft.apply("config", () => {});
    draft.apply("blockedApps", patchBlocked ?? (() => {}));
    return draft;
  }

  it("needs config and blockedApps from the server in this run", () => {
    expect([...REQUIRED_BEFORE_WRITE]).toEqual(["config", "blockedApps"]);
    const s = goodSnapshot();
    expect(snapshotWritable(new Set(["config"]), s)).toBe(false);
    expect(snapshotWritable(new Set(["blockedApps", "history"]), s)).toBe(false);
    expect(snapshotWritable(new Set(["config", "blockedApps"]), s)).toBe(true);
    // A good snapshot from disk doesn't count as heard: a fresh run must still wait.
    expect(new SnapshotDraft(goodSnapshot()).writable()).toBe(false);
  });

  it("(d) the 15:41 near-empty case is still refused: sign-out then sign-in, public/userName first", () => {
    // Sign out deleted snapshot.json and forgot the boot snapshot: the next run starts empty.
    const draft = new SnapshotDraft(emptySnapshot(UID));
    draft.apply("public/userName", (s) => (s.handle = "PARROTTEST"));
    expect(draft.writable()).toBe(false); // this is what was written at 15:41:48
    draft.apply("friends", (s) => (s.friends = []));
    draft.apply("history", (s) => (s.history = {}));
    expect(draft.writable()).toBe(false);
    draft.apply("config", (s) => (s.config = { userName: "PARROTTEST", onboardingComplete: true }));
    expect(draft.writable()).toBe(false);
    draft.apply("blockedApps", (s) => {
      s.blockedAppsRaw = { a: "notepad.exe" };
      s.blockedApps = ["notepad.exe"];
    });
    expect(draft.writable()).toBe(true);
    expect(draft.snapshot.config.userName).toBe("PARROTTEST");
  });

  it("a missing or empty config is never written, even once both have answered", () => {
    const empty = new SnapshotDraft(emptySnapshot(UID));
    empty.apply("config", (s) => (s.config = {}));
    empty.apply("blockedApps", () => {});
    expect(empty.writable()).toBe(false);
    const lost = heardBoth();
    lost.apply("config", (s) => (s.config = {})); // the server now says config is gone
    expect(lost.writable()).toBe(false);
  });

  it("(a) removing one blocked app is written", () => {
    const draft = heardBoth((s) => {
      s.blockedAppsRaw = {};
      s.blockedApps = [];
    });
    // Start from two blocks, then the server answers with one.
    draft.apply("blockedApps", (s) => {
      s.blockedAppsRaw = { a: "notepad.exe", b: "spotify.exe" };
      s.blockedApps = ["notepad.exe", "spotify.exe"];
    });
    draft.apply("blockedApps", (s) => {
      s.blockedAppsRaw = { a: "notepad.exe" };
      s.blockedApps = ["notepad.exe"];
    });
    expect(draft.snapshot.blockedApps).toEqual(["notepad.exe"]);
    expect(draft.writable()).toBe(true);
  });

  it("(b) Clear All Blocks (empty blockedApps) is written", () => {
    const draft = heardBoth((s) => {
      s.blockedAppsRaw = {};
      s.blockedApps = [];
      s.permanentExe = [];
      s.customBlocks = {};
      s.permanentBlocks = {};
    });
    expect(draft.snapshot.blockedApps).toEqual([]);
    expect(draft.writable()).toBe(true);
  });

  it("(c) removing a friend is written", () => {
    const draft = heardBoth();
    draft.apply("friends", (s) => (s.friends = [{ uid: "f1", name: "ALPHA" }, { uid: "f2", name: "BRAVO" }]));
    draft.apply("friends", (s) => (s.friends = [{ uid: "f1", name: "ALPHA" }]));
    expect(draft.writable()).toBe(true);
    draft.apply("friends", (s) => (s.friends = []));
    expect(draft.writable()).toBe(true);
  });

  it("compares no list lengths: only the two answers and a non-empty config decide", () => {
    const gate = src("./snapshotGate.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(gate).not.toMatch(/blockedApps\.length|friends|history|sessionHistory|previous|isEmptier/);
    expect(gate.match(/\.length/g)).toHaveLength(1); // Object.keys(next.config).length only
  });

  it("useSnapshotWriter writes only through the gate, seeded only from this account's snapshot", () => {
    const hook = src("./hooks/useSnapshotWriter.ts");
    expect(hook.match(/writeSnapshot\(/g)).toHaveLength(1);
    expect(hook).toContain("if (draft.current?.writable()) writeSnapshot(draft.current.snapshot);");
    expect(hook).toContain("const previous = boot?.uid === userId ? boot : null;");
    expect(hook).toContain("(snap) => patch(path, (s) => apply(snap.val(), s)),");
  });
});

describe("fix 3: the sync watchdog's timing", () => {
  /** Ticks every CHECK_MS from 0 to untilMs; returns the times it kicked. */
  function run(untilMs: number, at: (t: number) => { connected: boolean; hostAnswers: boolean }): number[] {
    let state: WatchdogState = WATCHDOG_START;
    const kicks: number[] = [];
    for (let t = 0; t <= untilMs; t += CHECK_MS) {
      const step = watchdogStep(state, { ...at(t), now: t });
      state = step.state;
      if (step.kick) kicks.push(t);
    }
    return kicks;
  }

  it("kicks after 60 s stuck while the host answers, then at most once per 5 min", () => {
    expect(STUCK_MS).toBe(60_000);
    expect(MIN_GAP_MS).toBe(300_000);
    const kicks = run(16 * 60_000, () => ({ connected: false, hostAnswers: true }));
    expect(kicks[0]).toBe(STUCK_MS);
    for (let i = 1; i < kicks.length; i++) expect(kicks[i] - kicks[i - 1]).toBe(MIN_GAP_MS);
    expect(kicks).toEqual([60_000, 360_000, 660_000, 960_000]);
  });

  it("never kicks while connected, or while the host doesn't answer (that is real offline)", () => {
    expect(run(30 * 60_000, () => ({ connected: true, hostAnswers: true }))).toEqual([]);
    expect(run(30 * 60_000, () => ({ connected: false, hostAnswers: false }))).toEqual([]);
  });

  it("counts the 60 s only while the host answers: an offline stretch restarts the count", () => {
    // Host down until 50 s, then answering but not connected: first kick 60 s later.
    expect(run(3 * 60_000, (t) => ({ connected: false, hostAnswers: t >= 50_000 }))[0]).toBe(110_000);
    // A blip of connection at 40 s restarts the count too.
    expect(run(3 * 60_000, (t) => ({ connected: t === 40_000, hostAnswers: true }))[0]).toBe(105_000);
  });

  it("a connection that recovers after a kick is left alone", () => {
    expect(run(20 * 60_000, (t) => ({ connected: t > 65_000, hostAnswers: true }))).toEqual([60_000]);
  });

  it("the hook cycles the connection, refreshes the token and logs sync-reconnect", () => {
    const hook = src("./hooks/useSyncWatchdog.ts");
    for (const call of ['logUiEvent("sync-reconnect", userId)', "goOffline(db)", "goOnline(db)", "getIdToken(true)"]) {
      expect(hook).toContain(call);
    }
    expect(src("./App.tsx")).toContain("useSyncWatchdog(user?.uid, reachabilitySettled && reachable);");
  });
});

describe("ui-events.log: every event the webview logs is on Rust's allowlist", () => {
  it("matches lib.rs UI_EVENTS", () => {
    const ts = [...src("./uiEventLog.ts").matchAll(/\|\s+"([a-z-]+)"/g)].map((m) => m[1]);
    const rust = /const UI_EVENTS: &\[&str\] = &\[([\s\S]*?)\];/.exec(src("../../desktop/src-tauri/src/lib.rs"))![1];
    expect(ts).toContain("sync-reconnect");
    for (const e of ts) expect(rust).toContain(`"${e}"`);
  });
});
