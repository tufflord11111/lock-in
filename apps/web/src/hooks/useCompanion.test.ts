/**
 * "Show the parrot": the switch takes effect at once and survives a restart.
 *
 * No DOM here, so React's hooks are stood in for (effects run as soon as they are
 * declared), and so are Firebase and Tauri. The Realtime Database raises a local
 * write on the writer's own listener before the server answers; the fake does the
 * same, which is what makes the switch immediate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<[string, unknown]> = [];
const listeners = new Map<string, (snap: { val: () => unknown }) => void>();
const server = new Map<string, Record<string, unknown>>();
const storage = new Map<string, string>();

vi.mock("react", () => ({
  useRef: (v: unknown) => ({ current: v }),
  useState: (v: unknown) => [v, () => {}],
  useEffect: (fn: () => void) => void fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => {
    calls.push([cmd, args]);
    return Promise.resolve();
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: () => Promise.resolve(),
  listen: () => Promise.resolve(() => {}),
}));
vi.mock("@lock-in/firebase", () => ({ db: {} }));
vi.mock("firebase/database", () => ({
  ref: (_db: unknown, path: string) => path,
  onValue: (path: string, cb: (snap: { val: () => unknown }) => void) => {
    listeners.set(path, cb);
    return () => listeners.delete(path);
  },
  update: (path: string, patch: Record<string, unknown>) => {
    const next = { ...(server.get(path) ?? {}), ...patch };
    server.set(path, next);
    listeners.get(path)?.({ val: () => next });
    return Promise.resolve();
  },
}));
vi.mock("../writeFailures", () => ({ guardWrite: (p: Promise<unknown>) => p }));

const UID = "parrottest";
const NODE = `users/${UID}/config/companion`;
const enabledCalls = () => calls.filter(([c]) => c === "companion_set_enabled").map(([, a]) => (a as { enabled: boolean }).enabled);

beforeEach(() => {
  calls.length = 0;
  listeners.clear();
  server.clear();
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  vi.stubGlobal("window", { setTimeout: () => 0, clearTimeout: () => {} });
});

describe("Show the parrot", () => {
  it("is on by default: nothing stored shows the bird", async () => {
    const { useCompanionSettings } = await import("./useCompanion");
    useCompanionSettings(UID);
    listeners.get(NODE)?.({ val: () => null });
    expect(enabledCalls().at(-1)).toBe(true);
  });

  it("turns the bird off and on at once, without waiting for the server", async () => {
    const { useCompanionSettings, writeCompanionSettings } = await import("./useCompanion");
    useCompanionSettings(UID);
    listeners.get(NODE)?.({ val: () => null });
    calls.length = 0;
    // The switch in parrot settings writes just this.
    void writeCompanionSettings(UID, { enabled: false });
    expect(enabledCalls()).toEqual([false]);
    void writeCompanionSettings(UID, { enabled: true });
    expect(enabledCalls()).toEqual([false, true]);
    expect(server.get(NODE)).toMatchObject({ enabled: true, v: 1 });
  });

  it("stays off across a restart, before Firebase answers (offline too)", async () => {
    const { useCompanionSettings, writeCompanionSettings } = await import("./useCompanion");
    useCompanionSettings(UID);
    listeners.get(NODE)?.({ val: () => null });
    void writeCompanionSettings(UID, { enabled: false });
    // Restart: a new main window, same PC. The account hasn't answered yet.
    calls.length = 0;
    listeners.clear();
    useCompanionSettings(UID);
    expect(enabledCalls()).toEqual([false]);
    // And the account, when it answers, says the same: it was saved there too.
    listeners.get(NODE)?.({ val: () => server.get(NODE) });
    expect(enabledCalls()).toEqual([false, false]);
  });

  it("the switch in parrot settings is what writes it", async () => {
    const { readFileSync } = await import("node:fs");
    const settings = readFileSync(new URL("../components/CompanionSettings.tsx", import.meta.url), "utf8");
    expect(settings).toMatch(/onClick=\{\(\) => void writeCompanionSettings\(userId, \{ enabled: !settings\.enabled \}\)\}/);
    expect(settings).toMatch(/aria-label="Show the parrot"/);
  });
});
