/**
 * Sign out -> sign in leaves the Realtime Database stuck on a transport the
 * CSP blocks. Runs the real browser build of the RTDB SDK against a fake
 * WebSocket and a stub DOM; nothing reaches the network.
 *
 * Mechanism (@firebase/database 1.1.x):
 * - Every WebSocket open writes localStorage firebase:previous_websocket_failure
 *   = true; it is removed only once the socket has had 2 data responses.
 * - A socket opened while signed out sends no auth and no listens, gets no data
 *   responses, and is closed as unhealthy after 30 s. The flag stays true.
 * - The next connection sees the flag and starts with long-polling (JSONP
 *   <script> tags) to the cached shard host firebase:host:<ns> = s-....
 *   tauri.conf.json's script-src/frame-src allow only the default host, so the
 *   poll never connects and the WebSocket is never tried again. Restarting the
 *   app does not clear localStorage; resetting the WebView profile does.
 */
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    sent: string[] = [];
    closed = false;
    constructor(public url: string) {
      sockets.push(this);
    }
    send(d: string) {
      this.sent.push(d);
    }
    close() {
      this.closed = true;
    }
  }
  // Long-poll builds an iframe and <script src=...>; record every src it sets.
  const pollUrls: string[] = [];
  const absorb = (): unknown =>
    new Proxy(function () {}, {
      get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : absorb()),
      set: (_t, k, v) => {
        if (k === "src" && typeof v === "string" && v.startsWith("https://")) pollUrls.push(v);
        return true;
      },
      apply: () => absorb(),
      construct: () => absorb() as object,
    });
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, WebSocket: g.WebSocket };
  g.window = { localStorage: storage, sessionStorage: storage, addEventListener() {}, removeEventListener() {} };
  g.document = {
    readyState: "complete",
    body: absorb(),
    createElement: () => absorb(),
    addEventListener() {},
    removeEventListener() {},
  };
  g.WebSocket = FakeSocket;
  return { storage, sockets, pollUrls, saved };
});

// The app's own @lock-in/firebase config, with the browser build of the RTDB
// SDK (what WebView2 runs) in place of the Node build vitest would pick.
vi.mock("firebase/database", async () => {
  const fb = realpathSync(fileURLToPath(new URL("../node_modules/firebase", import.meta.url)));
  const dbDir = realpathSync(join(fb, "..", "@firebase", "database"));
  const mod = await import(pathToFileURL(join(dbDir, "dist", "index.esm.js")).href);
  // The browser build still imports @firebase/util's Node build here, which
  // sets NODE_CLIENT = true and so turns long-polling off. WebView2 loads the
  // browser build of util, where it is false.
  const util = realpathSync(join(dbDir, "..", "util"));
  const { CONSTANTS } = await import(pathToFileURL(join(util, "dist", "node-esm", "index.node.esm.js")).href);
  CONSTANTS.NODE_CLIENT = false;
  return mod;
});

const SHARD = "s-gke-apse1-nssi1-1.asia-southeast1.firebasedatabase.app";

afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  Object.assign(g, env.saved);
  vi.useRealTimers();
});

describe("Realtime Database transport after sign-out", () => {
  it("a signed-out socket closed as unhealthy does not leave sync on a long-poll the CSP blocks", async () => {
    vi.useFakeTimers();
    const { db } = await import("@lock-in/firebase");
    const { onValue, ref } = await import("firebase/database");
    const off = onValue(ref(db, ".info/connected"), () => {});
    await vi.advanceTimersByTimeAsync(2_000);

    // Signed out: the server's handshake names the shard, then nothing else.
    expect(env.sockets).toHaveLength(1);
    const first = env.sockets[0];
    first.onopen?.();
    first.onmessage?.({
      data: JSON.stringify({ t: "c", d: { t: "h", d: { ts: Date.now(), v: "5", h: SHARD, s: "test-session" } } }),
    });
    await vi.advanceTimersByTimeAsync(31_000); // healthy timeout: 30 s
    expect(first.closed).toBe(true);
    expect(env.storage.getItem("firebase:previous_websocket_failure")).toBe("true");
    expect(JSON.parse(env.storage.getItem(`firebase:host:${new URL(db.app.options.databaseURL!).host}`)!)).toBe(SHARD);

    // The reconnect sign-in would use.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    off();

    expect(env.pollUrls.map((u) => new URL(u).host)).toEqual([]);
    expect(env.sockets.length).toBeGreaterThan(1);
    expect(new URL(env.sockets[1].url).host).toBe(SHARD);
  });

  it("the CSP lets the shard host in by WebSocket only, never as a script or frame", () => {
    const conf = JSON.parse(
      readFileSync(new URL("../../desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8")
    );
    const csp: string = conf.app.security.csp;
    const directive = (name: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(name + " ")) ?? "";
    const allows = (d: string, host: string) =>
      d.split(/\s+/).slice(1).some((s) => {
        const h = s.replace(/^[a-z]+:\/\//, "");
        return h === host || (h.startsWith("*.") && host.endsWith(h.slice(1)));
      });
    expect(allows(directive("connect-src"), SHARD)).toBe(true);
    expect(allows(directive("script-src"), SHARD)).toBe(false);
    expect(allows(directive("frame-src"), SHARD)).toBe(false);
  });
});
