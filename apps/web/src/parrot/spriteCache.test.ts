import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SCALES, frameRect, scaleFiles } from "./animator";
import { initialState, nextRows, type BirdState, type Mode } from "./machine";
import { SPRITE_BUDGET_BYTES, createSpriteCache, planEvictions } from "./spriteCache";
import { wantedFiles } from "./look";

/** A cache over fake decodes that resolve when the test says. */
function harness(sizes: Record<string, number>, budget = 100) {
  const waiting = new Map<string, (b: string) => void>();
  const decoded: string[] = [];
  const freed: string[] = [];
  const ready: string[] = [];
  let clock = 0;
  const cache = createSpriteCache<string>({
    decode: (file) =>
      new Promise((resolve) => {
        decoded.push(file);
        waiting.set(file, resolve);
      }),
    free: (b) => freed.push(b),
    bytesOf: (file) => sizes[file] ?? 0,
    onReady: (file) => ready.push(file),
    now: () => ++clock,
    budget,
  });
  const finish = async (file: string) => {
    waiting.get(file)?.(`bitmap:${file}`);
    waiting.delete(file);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { cache, decoded, freed, ready, finish };
}

describe("the sprite cache", () => {
  it("has nothing to draw until a row is decoded, then says so, and decodes each file once", async () => {
    const h = harness({ a: 10 });
    h.cache.want(["a"]);
    h.cache.want(["a"]);
    expect(h.cache.get("a")).toBeUndefined();
    expect(h.decoded).toEqual(["a"]);
    await h.finish("a");
    expect(h.ready).toEqual(["a"]);
    expect(h.cache.get("a")).toBe("bitmap:a");
  });

  it("keeps a row it has shown decoded: going back to it never waits", async () => {
    const h = harness({ idle: 10, walk: 10 });
    h.cache.want(["idle"]);
    await h.finish("idle");
    h.cache.want(["walk", "idle"]);
    await h.finish("walk");
    h.cache.want(["idle", "walk"]);
    expect(h.cache.get("idle")).toBe("bitmap:idle");
    expect(h.decoded).toEqual(["idle", "walk"]);
  });

  it("decodes the rows that may come next before they are shown", async () => {
    const h = harness({ idle: 10, walk: 10, peck: 10 });
    h.cache.want(["idle", "walk", "peck"]);
    expect(h.decoded).toEqual(["idle", "walk", "peck"]);
    await h.finish("walk");
    expect(h.cache.get("walk")).toBe("bitmap:walk");
  });

  it("stays within its budget: the rows that may come next only if they fit, the least recently used freed first", async () => {
    const h = harness({ a: 40, b: 40, c: 40, d: 40, e: 40 }, 100);
    h.cache.want(["a", "b"]);
    await h.finish("a");
    await h.finish("b");
    // c is needed now; d may come next, and a and b, which nothing wants now, make room for it,
    // the least recently used first. e would not fit even then.
    h.cache.want(["c", "d", "e"]);
    expect(h.decoded).toEqual(["a", "b", "c", "d"]);
    expect(h.freed).toEqual(["bitmap:a", "bitmap:b"]);
    await h.finish("c");
    await h.finish("d");
    expect(h.cache.bytes()).toBeLessThanOrEqual(100);
    expect(h.cache.files().sort()).toEqual(["c", "d"]);
  });

  it("never frees a row that is wanted, however tight the budget", async () => {
    const h = harness({ a: 80, b: 80 }, 100);
    h.cache.want(["a"]);
    await h.finish("a");
    expect(planEvictions([{ file: "a", bytes: 80, usedAt: 1 }, { file: "b", bytes: 80, usedAt: 2 }], ["a", "b"], 100)).toEqual([]);
    h.cache.want(["b", "a"]);
    await h.finish("b");
    expect(h.cache.get("a")).toBe("bitmap:a");
    expect(h.cache.get("b")).toBe("bitmap:b");
  });

  // 1.3.0 MSIX: the bird landed on the branch and froze on its last landing frame, awake, with the
  // landing grip's strip over the bark. Sleep's grip (frontGrip sleep) was never decoded: rows
  // nothing wanted any more (walk, drag, pet...) filled the budget, and a file after the first was
  // refused rather than making room. The frame waits for its grip, and asleep the loop is stopped.
  it("makes room for a wanted file by freeing what nothing wants, instead of refusing it", async () => {
    const h = harness({ idle: 45, walk: 45, sleep: 5, grip: 6 }, 100);
    h.cache.want(["idle", "walk"]);
    await h.finish("idle");
    await h.finish("walk");
    h.cache.want(["sleep", "grip"]);
    expect(h.decoded).toEqual(["idle", "walk", "sleep", "grip"]);
    await h.finish("sleep");
    await h.finish("grip");
    expect(h.cache.get("grip")).toBe("bitmap:grip");
    expect(h.cache.bytes()).toBeLessThanOrEqual(100);
  });

  it("always loads the files the frame on screen needs (the row and its layers), even over budget", async () => {
    const h = harness({ row: 60, under: 30, over: 30, next: 10 }, 100);
    h.cache.want(["row", "under", "over", "next"], 3);
    expect(h.decoded).toEqual(["row", "under", "over"]);
  });

  it("the overlay asks for the frame's row and its layers first, as required, then what may come next", () => {
    const bird = readFileSync(new URL("./bird.ts", import.meta.url), "utf8");
    expect(bird).toContain("const needNow = [rect.file, ...(under ? [under.file] : []), ...(over ? [over.file] : [])];");
    expect(bird).toContain("sprites.want([...new Set([...needNow, ...wantedFiles(state, now, scale)])], needNow.length);");
    // The layers are worked out before the want, not after.
    expect(bird.indexOf("const over = look.over")).toBeLessThan(bird.indexOf("sprites.want("));
  });

  it("survives a row that won't decode: nothing held, nothing thrown", async () => {
    const cache = createSpriteCache<string>({
      decode: () => Promise.reject(new Error("bad png")),
      free: () => {},
      bytesOf: () => 1,
      onReady: () => {},
    });
    cache.want(["bad"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.get("bad")).toBeUndefined();
    expect(cache.bytes()).toBe(0);
  });
});

describe("decoded sprite memory, with the art as shipped", () => {
  const MODES: Mode[] = ["idle", "walk", "peck", "preen", "mutter", "perch", "sleep", "wake", "happy", "talk", "drag", "fall", "flight"];
  const T0 = 1_000_000;

  it("holds what any state may draw next within the 30 MB budget, at every display scale", () => {
    expect(SPRITE_BUDGET_BYTES).toBe(30 * 1024 * 1024);
    let worst = 0;
    for (const scale of SCALES) {
      const sizes = scaleFiles(scale);
      for (const mode of MODES) {
        for (const onBranch of [false, true]) {
          const s: BirdState = { ...initialState(T0, 1440, false, false, 0.5), mode, onBranch };
          const bytes = [...new Set(nextRows(s, T0).map((row) => frameRect(scale, row, 0).file))].reduce((n, f) => n + (sizes.get(f) ?? 0), 0);
          worst = Math.max(worst, bytes);
          expect(bytes, `${mode}${onBranch ? " on the branch" : ""} at ${scale.cell.width} px`).toBeLessThanOrEqual(SPRITE_BUDGET_BYTES);
        }
      }
    }
    // For the report: the most any state asks for, at the sharpest scale.
    console.log(`sprite memory, most any state asks for: ${(worst / 2 ** 20).toFixed(1)} MiB of ${SPRITE_BUDGET_BYTES / 2 ** 20}`);
  });

  it("lands asleep on the branch with its grip, after a day that filled the cache (as measured on the 1.3.0 MSIX)", async () => {
    // The 24 files the overlay held when it froze, 29.81 MiB at 2x: sleep's grip (0.46 MiB) didn't fit.
    const scale = SCALES.find((s) => s.maxDpr === null)!;
    const sizes = scaleFiles(scale);
    const file = (f: string) => [...sizes.keys()].find((k) => k.endsWith(f))!;
    const held = [
      "parrot-2x/idle.png", "parrot-2x/walk.png", "parrot-2x/peck.png", "parrot-2x/idle_preen.png", "parrot-2x/talk.png",
      "parrot-2x/takeoff.png", "parrot-2x/drag.png", "parrot-2x/pet.png", "underband-2x/idle.png", "underband-2x/walk.png",
      "underband-2x/peck.png", "underband-2x/idle_preen.png", "underband-2x/talk.png", "underband-2x/takeoff.png",
      "underband-2x/pet.png", "parrot-2x/perch.png", "underband-2x/perch.png", "parrot-2x/fly.png", "parrot-2x/land.png",
      "parrot-2x/sleep.png", "underband-2x/land.png", "underband-2x/sleep.png", "frontGrip-2x/takeoff.png", "frontGrip-2x/land.png",
    ].map(file);
    const decoded: string[] = [];
    const cache = createSpriteCache<string>({
      decode: (f) => (decoded.push(f), Promise.resolve(`bitmap:${f}`)),
      free: () => {},
      bytesOf: (f) => sizes.get(f) ?? 0,
      onReady: () => {},
    });
    cache.want(held);
    await new Promise((r) => setTimeout(r, 0));
    expect(cache.files().length).toBe(24);
    // Asleep on the branch, frame 0: what bird.ts asks for (the frame's row and grip first).
    const asleep: BirdState = { ...initialState(T0, 1440, false, true, 0.5), mode: "sleep", onBranch: true };
    const grip = file("frontGrip-2x/sleep.png");
    cache.want([...new Set([frameRect(scale, "sleep", 0).file, grip, ...wantedFiles(asleep, T0, scale)])], 2);
    await new Promise((r) => setTimeout(r, 0));
    expect(decoded).toContain(grip);
    expect(cache.get(grip)).toBe(`bitmap:${grip}`);
    // Even as wantedFiles alone asks for it, with nothing marked as needed now.
    const fresh: string[] = [];
    const c2 = createSpriteCache<string>({ decode: (f) => (fresh.push(f), Promise.resolve(f)), free: () => {}, bytesOf: (f) => sizes.get(f) ?? 0, onReady: () => {} });
    c2.want(held);
    await new Promise((r) => setTimeout(r, 0));
    c2.want(wantedFiles(asleep, T0, scale));
    expect(fresh).toContain(grip);
  });
});
