/**
 * Tauri refuses an event name outside [A-Za-z0-9-/:_], and refuses it at runtime: listen()
 * rejects. In 1.3.0 the overlay's boot() awaited listen("parrot:branch-range?") and threw there,
 * so nothing after it ran: the 60 s world backstop, the pointer-up focus hand-back, the
 * context-menu guard and companion:hello. Every Tauri event name in the app must be legal.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const LEGAL = /^[A-Za-z0-9\-/:_]+$/;
const webSrc = fileURLToPath(new URL("..", import.meta.url));
const rustSrc = fileURLToPath(new URL("../../../desktop/src-tauri/src", import.meta.url));

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p, ext) : ext.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

/** Event names passed to Tauri's listen / once / emit / emitTo in TS, and emit / emit_to / listen in Rust. */
function eventNames(): Array<{ name: string; where: string }> {
  const out: Array<{ name: string; where: string }> = [];
  const add = (name: string, where: string) => out.push({ name, where });
  for (const f of files(webSrc, /\.(ts|tsx)$/)) {
    const src = readFileSync(f, "utf8");
    if (!/@tauri-apps\/api\/event/.test(src)) continue;
    for (const m of src.matchAll(/\b(?:listen|once|emit)(?:<[^>()]*>)?\(\s*"([^"]+)"/g)) add(m[1], f);
    // The overlay's boot() registers its listeners through a local on(name, handler).
    for (const m of src.matchAll(/\bon(?:<[^>()]*>)?\(\s*"([^"]+)"/g)) add(m[1], f);
    for (const m of src.matchAll(/\bemitTo(?:<[^>()]*>)?\(\s*"[^"]+"\s*,\s*"([^"]+)"/g)) add(m[1], f);
  }
  for (const f of files(rustSrc, /\.rs$/)) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/\.emit(?:_to)?\(\s*(?:[A-Za-z_]+\s*,\s*)?"([^"]+)"/g)) add(m[1], f);
    for (const m of src.matchAll(/\.listen(?:_any)?\(\s*"([^"]+)"/g)) add(m[1], f);
  }
  return out;
}

describe("Tauri event names", () => {
  it("are found in the overlay, the main window and Rust (the check sees them)", () => {
    const names = new Set(eventNames().map((e) => e.name));
    for (const known of ["parrot-world", "companion:hello", "parrot:branch-reset", "parrot:branch-range-request", "lockdown-warning"]) expect(names).toContain(known);
  });

  it("use only the characters Tauri accepts, so no listen() rejects and stops boot()", () => {
    const bad = eventNames().filter((e) => !LEGAL.test(e.name)).map((e) => `${e.name}  (${e.where.split(/[\\/]src[\\/]/).pop()})`);
    expect(bad).toEqual([]);
  });

  it("the overlay's boot() can't be stopped part-way by one refused listener or a failed hello", () => {
    const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    const body = main.slice(main.indexOf("async function boot()"));
    // No bare await on a listen() or on the hello: each is caught.
    expect(body).not.toMatch(/await listen/);
    expect(body).not.toMatch(/await emitTo\("main", "companion:hello"\);/);
    // The setup that can't fail comes before the first listener.
    const firstListener = body.indexOf('on<NativeWorld>("parrot-world"');
    expect(firstListener).toBeGreaterThan(0);
    for (const setup of ["window.setInterval(", 'addEventListener("pointerup"', 'addEventListener("contextmenu"']) {
      expect(body.indexOf(setup)).toBeGreaterThan(0);
      expect(body.indexOf(setup)).toBeLessThan(firstListener);
    }
    // A refused listener is logged and boot carries on; boot itself is caught.
    expect(body).toMatch(/listen<T>\(event, handler\)\.then\(\s*\(\) => true,\s*\(err\) => \{\s*console\.warn/);
    expect(main).toMatch(/void boot\(\)\.catch\(/);
  });
});
