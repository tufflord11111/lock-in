import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 1.3.1 M10: index.html's CSP is the PWA's, and inside the desktop app it is
// enforced alongside tauri.conf.json's, so it must allow the same database
// hosts. The RTDB handshake moves the connection to a shard host in the same
// region (s-gke-….asia-southeast1.firebasedatabase.app): connect-src allows
// the region; script-src and frame-src (long-polling) keep the exact host.
const HOST = "synchrofocus-ac0f2-default-rtdb.asia-southeast1.firebasedatabase.app";
const REGION = ["https://*.asia-southeast1.firebasedatabase.app", "wss://*.asia-southeast1.firebasedatabase.app"];
const DEV_ONLY = /^(http|ws):\/\/(ipc\.)?localhost:\*$/;

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)![1];
const directives = new Map(
  csp
    .split(";")
    .map((d) => d.trim().split(/\s+/))
    .filter((p) => p[0])
    .map(([name, ...values]) => [name, values] as const)
);

describe("index.html's CSP (also applied inside the desktop app)", () => {
  it("has no unsafe-eval and no bare scheme where code or connections come from", () => {
    expect(csp).not.toContain("unsafe-eval");
    for (const name of ["default-src", "script-src", "connect-src", "frame-src"]) {
      for (const bare of ["https:", "wss:", "http:", "ws:", "*"]) expect(directives.get(name)).not.toContain(bare);
    }
  });

  it("allows the database's region in connect-src, and no other wildcard", () => {
    const connect = directives.get("connect-src")!;
    for (const r of REGION) expect(connect).toContain(r);
    const wild = [...directives.values()].flat().filter((s) => s.includes("*") && !DEV_ONLY.test(s));
    expect(wild.sort()).toEqual([...REGION].sort());
  });

  it("keeps the exact host for the long-polling fallback", () => {
    expect(directives.get("script-src")).toContain(`https://${HOST}`);
    expect(directives.get("frame-src")).toContain(`https://${HOST}`);
    for (const name of ["script-src", "frame-src"]) {
      expect(directives.get(name)!.some((s) => s.includes("*"))).toBe(false);
    }
  });
});

// The [•] loader runs before React. It must work under this CSP and Tauri's:
// no inline <script> (Tauri adds hashes and nonces to its header CSP, which
// switches off 'unsafe-inline'), no eval. It is a same-origin classic script
// that runs before the deferred app module.
describe("the loading screen under the 1.3.1 CSP", () => {
  const scripts = (page: string) => [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  const loader = readFileSync(new URL("../public/loader.js", import.meta.url), "utf8");
  const tauriCsp: string = JSON.parse(
    readFileSync(new URL("../../desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8")
  ).app.security.csp;

  it("has no inline script in index.html or parrot.html", () => {
    const parrot = readFileSync(new URL("../parrot.html", import.meta.url), "utf8");
    for (const page of [html, parrot]) {
      const found = scripts(page);
      expect(found.length).toBeGreaterThan(0);
      for (const [, attrs, body] of found) {
        expect(attrs).toMatch(/\ssrc="\/[^"]+"/);
        expect(body.trim()).toBe("");
      }
    }
  });

  it("loads /loader.js from the same origin, as a classic script before the app module", () => {
    const srcs = scripts(html).map(([, attrs]) => attrs);
    const at = srcs.findIndex((a) => a.includes('src="/loader.js"'));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(srcs[at]).not.toMatch(/type=|async|defer/);
    expect(at).toBeLessThan(srcs.findIndex((a) => a.includes('src="/src/main.tsx"')));
    expect(html.indexOf('id="li-loader"')).toBeLessThan(html.indexOf('src="/loader.js"'));
    expect(directives.get("script-src")).toContain("'self'");
    expect(tauriCsp).toMatch(/script-src 'self'/);
  });

  it("needs no eval, and neither CSP allows it", () => {
    expect(loader).toContain("window.lockInLoaderFinish");
    expect(loader).not.toMatch(/\beval\s*\(|new Function|setTimeout\(\s*['"`]|setInterval\(\s*['"`]/);
    expect(csp).not.toContain("unsafe-eval");
    expect(tauriCsp).not.toContain("unsafe-eval");
  });
});
