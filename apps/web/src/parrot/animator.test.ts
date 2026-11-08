import { describe, expect, it, vi } from "vitest";
import {
  COLUMNS,
  DISPLAY_CELL,
  ROWS,
  SCALES,
  cellOffset,
  createLoop,
  decodedBytes,
  frameAt,
  frameRect,
  scaleFiles,
  playedOnce,
  rowOf,
  scaleFor,
  sheetSize,
  ROW_FILES_OVER_BYTES,
  type Cell,
  type LoopHost,
  type LoopPlan,
  type SheetScale,
} from "./animator";
import manifest from "./sprites.manifest.json";

describe("the manifest", () => {
  it("has the 17 rows of the art spec, in order, none longer than the spec's 96 frames allow", () => {
    const SPEC: [string, number][] = [
      ["idle", 6], ["idle_blink", 3], ["idle_preen", 8], ["walk", 8], ["takeoff", 4], ["fly", 6], ["land", 4],
      ["perch", 4], ["sleep", 4], ["talk", 6], ["drag", 4], ["wake", 5], ["peck", 6], ["happy", 8], ["sad", 6],
      ["yawn", 8], ["droopy_idle", 6],
    ];
    expect(SPEC.reduce((n, [, f]) => n + f, 0)).toBe(96);
    expect(ROWS.map((r) => r.state)).toEqual(SPEC.map(([state]) => state));
    // The art may cut a row short (the gen walk and idle have 4 frames), never make it longer,
    // except that takeoff may open and land close on a copy of idle frame 0 (parrot-art a42ccc2).
    const IDLE_BRIDGE = ["takeoff", "land"];
    ROWS.forEach((r, i) => {
      expect(r.frames, r.state).toBeGreaterThanOrEqual(1);
      expect(r.frames, r.state).toBeLessThanOrEqual(SPEC[i][1] + (IDLE_BRIDGE.includes(r.state) ? 1 : 0));
      expect(r.frames, r.state).toBeLessThanOrEqual(COLUMNS);
    });
  });

  it("sizes every sheet as 12 columns by 17 rows of its cell, width and height apart", () => {
    expect(COLUMNS).toBe(12);
    expect(ROWS.length).toBe(17);
    for (const s of SCALES) expect(s.sheet).toEqual(sheetSize(s.cell));
  });

  it("has 1x, 1.5x and 2x sheets, each the display cell scaled by one factor, so the art keeps its shape", () => {
    expect(SCALES.map((s) => s.cell.width / DISPLAY_CELL.width)).toEqual([1, 1.5, 2]);
    expect(SCALES.map((s) => s.cell.height / DISPLAY_CELL.height)).toEqual([1, 1.5, 2]);
    expect(SCALES.map((s) => s.maxDpr)).toEqual([1.25, 1.75, null]);
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
    const frameMs = 1000 / walk.fps;
    expect(frameAt(walk, 0)).toBe(0);
    expect(frameAt(walk, frameMs)).toBe(1);
    expect(frameAt(walk, walk.frames * frameMs - 1)).toBe(walk.frames - 1);
    expect(frameAt(walk, walk.frames * frameMs)).toBe(0);
    expect(frameAt({ ...walk, frames: 8, fps: 10 }, 750)).toBe(7);
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

  it("come from a whole sheet by column and row, or from a row file by column alone", () => {
    const whole: SheetScale = { maxDpr: null, cell: { width: 192, height: 160 }, sheet: { width: 2304, height: 2720 }, file: "parrot/parrot-2x.png" };
    const rows: SheetScale = { ...whole, file: undefined, rowFiles: "parrot/parrot-2x/{state}.png" };
    // In the image's own px: the scale's cell, not the display cell.
    expect(frameRect(whole, "walk", 2)).toEqual({ file: "parrot/parrot-2x.png", sx: 384, sy: 3 * 160, sw: 192, sh: 160 });
    expect(frameRect(rows, "walk", 2)).toEqual({ file: "parrot/parrot-2x/walk.png", sx: 384, sy: 0, sw: 192, sh: 160 });
    expect(() => frameRect({ ...whole, file: undefined }, "walk", 0)).toThrow();
  });

  it("know what each file holds once decoded: a row's frames, or the whole sheet", () => {
    const whole: SheetScale = { maxDpr: null, cell: { width: 192, height: 160 }, sheet: { width: 2304, height: 2720 }, file: "parrot/parrot-2x.png" };
    const rows: SheetScale = { ...whole, file: undefined, rowFiles: "parrot/parrot-2x/{state}.png" };
    expect([...scaleFiles(whole)]).toEqual([["parrot/parrot-2x.png", 2304 * 2720 * 4]]);
    const files = scaleFiles(rows);
    expect(files.size).toBe(17);
    expect(files.get("parrot/parrot-2x/walk.png")).toBe(rowOf("walk").frames * 192 * 160 * 4);
  });

  it("ship any sheet over 16 MiB decoded as row files", () => {
    expect(ROW_FILES_OVER_BYTES).toBe(16 * 1024 * 1024);
    expect(decodedBytes({ width: 2304, height: 3264 })).toBe(30_081_024);
    for (const s of SCALES) {
      if (decodedBytes(s.sheet) > ROW_FILES_OVER_BYTES) expect(s.rowFiles, `${s.file} is too big for one image`).toBeTruthy();
    }
  });

  it("use the sheet the display needs", () => {
    const [one, onePointFive, two] = SCALES;
    expect(scaleFor(1)).toBe(one);
    expect(scaleFor(1.25)).toBe(one);
    expect(scaleFor(1.5)).toBe(onePointFive);
    expect(scaleFor(1.75)).toBe(onePointFive);
    expect(scaleFor(2)).toBe(two);
    expect(scaleFor(3)).toBe(two);
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
