import { describe, expect, it, vi } from "vitest";
import {
  COLUMNS,
  DISPLAY_CELL,
  ROWS,
  SCALES,
  cellOffset,
  createLoop,
  frameAt,
  playedOnce,
  rowOf,
  scaleFor,
  sheetSize,
  type Cell,
  type LoopHost,
  type LoopPlan,
} from "./animator";
import manifest from "./sprites.manifest.json";

describe("the manifest", () => {
  it("has the 17 rows and 96 frames of the art spec, in order", () => {
    expect(ROWS.map((r) => r.state)).toEqual([
      "idle", "idle_blink", "idle_preen", "walk", "takeoff", "fly", "land", "perch", "sleep",
      "talk", "drag", "wake", "peck", "happy", "sad", "yawn", "droopy_idle",
    ]);
    expect(ROWS.reduce((n, r) => n + r.frames, 0)).toBe(96);
  });

  it("sizes every sheet as 12 columns by 17 rows of its cell, width and height apart", () => {
    expect(manifest.scales.map((s) => [s.cell.width, s.cell.height, s.sheet.width, s.sheet.height])).toEqual([
      [96, 96, 1152, 1632],
      [144, 144, 1728, 2448],
      [192, 192, 2304, 3264],
    ]);
    for (const s of SCALES) expect(s.sheet).toEqual(sheetSize(s.cell));
  });

  it("scales every sheet's cell from the display cell by one factor, so the art keeps its shape", () => {
    for (const s of SCALES) {
      const factor = s.cell.width / DISPLAY_CELL.width;
      expect(s.cell.height).toBe(DISPLAY_CELL.height * factor);
    }
  });

  it("never asks for more than 30 fps, or more frames than there are columns", () => {
    for (const r of ROWS) {
      expect(r.fps).toBeLessThanOrEqual(30);
      expect(r.frames).toBeLessThanOrEqual(COLUMNS);
    }
  });
});

describe("frames", () => {
  it("come from elapsed time and wrap on a looping row", () => {
    const walk = rowOf("walk");
    expect(frameAt(walk, 0)).toBe(0);
    expect(frameAt(walk, 100)).toBe(1);
    expect(frameAt(walk, 750)).toBe(7);
    expect(frameAt(walk, 800)).toBe(0);
  });

  it("hold the last frame on a one-shot row", () => {
    const wake = rowOf("wake");
    expect(frameAt(wake, 10_000)).toBe(4);
    expect(playedOnce(wake, 499)).toBe(false);
    expect(playedOnce(wake, 500)).toBe(true);
  });

  it("don't step backwards if the clock does", () => {
    expect(frameAt(rowOf("walk"), -5_000)).toBe(0);
  });

  it("are found by column and row on the sheet", () => {
    expect(cellOffset("idle", 0)).toEqual({ x: -0, y: -0 });
    expect(cellOffset("walk", 2)).toEqual({ x: -2 * DISPLAY_CELL.width, y: -3 * DISPLAY_CELL.height });
  });

  it("step by the cell's width across and its height down, on a cell that isn't square", () => {
    const wide: Cell = { width: 128, height: 80 };
    expect(cellOffset("walk", 2, wide)).toEqual({ x: -256, y: -240 });
    expect(cellOffset("droopy_idle", 5, wide)).toEqual({ x: -640, y: -16 * 80 });
    expect(sheetSize(wide)).toEqual({ width: 12 * 128, height: 17 * 80 });
  });

  it("use the sheet the display needs", () => {
    expect(scaleFor(1).cell.width).toBe(96);
    expect(scaleFor(1.25).cell.width).toBe(96);
    expect(scaleFor(1.5).cell.width).toBe(144);
    expect(scaleFor(1.75).cell.width).toBe(144);
    expect(scaleFor(2).cell.width).toBe(192);
    expect(scaleFor(3).cell.width).toBe(192);
  });

  it("throws on a row the manifest doesn't have", () => {
    expect(() => rowOf("moonwalk")).toThrow();
  });
});

function fakeHost() {
  const rafs = new Map<number, (ts: number) => void>();
  const timers = new Map<number, { cb: () => void; ms: number }>();
  let id = 0;
  const host: LoopHost = {
    raf: (cb) => (rafs.set(++id, cb), id),
    cancelRaf: (i) => void rafs.delete(i),
    setTimer: (cb, ms) => (timers.set(++id, { cb, ms }), id),
    clearTimer: (i) => void timers.delete(i),
  };
  return {
    host,
    rafs,
    timers,
    fireRaf(ts: number) {
      const pending = [...rafs.entries()];
      rafs.clear();
      for (const [, cb] of pending) cb(ts);
    },
    fireTimer() {
      const pending = [...timers.entries()];
      timers.clear();
      for (const [, t] of pending) t.cb();
    },
  };
}

describe("the loop", () => {
  it("steps at no more than 30 Hz on a 60 Hz display", () => {
    const f = fakeHost();
    const step = vi.fn((): LoopPlan => ({ kind: "frames" }));
    const loop = createLoop(f.host, step);
    loop.poke();
    step.mockClear();
    for (let i = 0; i <= 60; i++) f.fireRaf(i * (1000 / 60));
    expect(step.mock.calls.length).toBeLessThanOrEqual(31);
    expect(step.mock.calls.length).toBeGreaterThanOrEqual(29);
  });

  it("holds no rAF when nothing moves, only the one timer", () => {
    const f = fakeHost();
    const loop = createLoop(f.host, () => ({ kind: "wait", ms: 1000 }));
    loop.poke();
    expect(f.rafs.size).toBe(0);
    expect(f.timers.size).toBe(1);
    expect([...f.timers.values()][0].ms).toBe(1000);
    f.fireTimer();
    expect(f.rafs.size).toBe(0);
    expect(f.timers.size).toBe(1);
  });

  it("stops completely when nothing is due, and a poke restarts it", () => {
    const f = fakeHost();
    let plan: LoopPlan = { kind: "stop" };
    const step = vi.fn(() => plan);
    const loop = createLoop(f.host, step);
    loop.poke();
    expect(loop.running).toBe(false);
    expect(f.rafs.size + f.timers.size).toBe(0);
    plan = { kind: "frames" };
    loop.poke();
    expect(loop.running).toBe(true);
    expect(f.rafs.size).toBe(1);
  });

  it("never has two callbacks pending, however often it is poked", () => {
    const f = fakeHost();
    const loop = createLoop(f.host, () => ({ kind: "frames" }));
    for (let i = 0; i < 5; i++) loop.poke();
    expect(f.rafs.size).toBe(1);
    loop.stop();
    expect(f.rafs.size).toBe(0);
    expect(loop.running).toBe(false);
  });
});
