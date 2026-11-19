import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase/app";
import { getDatabase, goOffline, ref } from "firebase/database";
import { pinDatabaseHost } from "@lock-in/firebase/src/pinDatabaseHost";

// 1.3.1 M10: the desktop CSP allows only the database's own host. The RTDB
// handshake names a shard host (s-gke-….asia-southeast1.firebasedatabase.app,
// read 2026-11-19) and the SDK would move every later connection there, and
// cache it in localStorage. pinDatabaseHost keeps it on the database's host.
const HOST = "synchrofocus-ac0f2-default-rtdb.asia-southeast1.firebasedatabase.app";
const SHARD = "s-gke-apse1-nssi3-12.asia-southeast1.firebasedatabase.app";

type Info = { host: string; internalHost: string };
const infoOf = (db: ReturnType<typeof getDatabase>) =>
  (ref(db) as unknown as { _repo: { repoInfo_: Info } })._repo.repoInfo_;

const app = initializeApp({ projectId: "pin-test", apiKey: "x", databaseURL: `https://${HOST}` }, "pin-test");
afterAll(() => deleteApp(app));

describe("index.html's CSP (also applied inside the desktop app)", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)![1];
  it("has no unsafe-eval and names the database exactly", () => {
    expect(csp).not.toContain("unsafe-eval");
    const wild = csp.split(/[\s;]+/).filter((s) => s.includes("*") && !/^(http|ws):\/\/(ipc\.)?localhost:\*$/.test(s));
    expect(wild).toEqual([]);
    for (const s of [`https://${HOST}`, `wss://${HOST}`]) expect(csp).toContain(s);
  });
});

describe("pinDatabaseHost", () => {
  it("(control) without it, the SDK moves to the shard the handshake names", () => {
    const other = initializeApp({ projectId: "pin-control", apiKey: "x", databaseURL: `https://${HOST}` }, "pin-control");
    const db = getDatabase(other);
    goOffline(db);
    const info = infoOf(db);
    info.host = SHARD;
    expect(info.internalHost).toBe(SHARD);
    return deleteApp(other);
  });

  it("keeps the SDK on the database's own host after a handshake names a shard", () => {
    const store = new Map<string, string>([[`firebase:host:${HOST}`, JSON.stringify(SHARD)]]);
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const db = getDatabase(app);
    goOffline(db);
    expect(pinDatabaseHost(db)).toBe(true);
    const info = infoOf(db);
    expect(info.internalHost).toBe(HOST);
    expect(store.has(`firebase:host:${HOST}`)).toBe(false);

    // What Connection.onHandshake_ and onReset_ do.
    info.host = SHARD;
    expect(info.internalHost).toBe(HOST);
    expect(info.host).toBe(HOST);
    expect(store.has(`firebase:host:${HOST}`)).toBe(false);
  });
});
