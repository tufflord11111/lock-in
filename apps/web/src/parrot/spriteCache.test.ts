import { describe, expect, it } from "vitest";
import { SCALES, frameRect, scaleFiles } from "./animator";
import { initialState, nextRows, type BirdState, type Mode } from "./machine";
import { SPRITE_BUDGET_BYTES, createSpriteCache, planEvictions } from "./spriteCache";

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
    const h = harness({ a: 40, b: 40, c: 40, d: 40 }, 100);
    h.cache.want(["a", "b"]);
    await h.finish("a");
    await h.finish("b");
    // c is needed now; d would not fit as well.
    h.cache.want(["c", "d"]);
    expect(h.decoded).toEqual(["a", "b", "c"]);
    await h.finish("c");
    expect(h.cache.bytes()).toBeLessThanOrEqual(100);
    expect(h.freed).toEqual(["bitmap:a"]);
    expect(h.cache.files().sort()).toEqual(["b", "c"]);
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
});
