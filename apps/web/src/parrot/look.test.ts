import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROWS, SCALES, layerRect, rowOf, scaleFiles } from "./animator";
import { beginFlight, initialState, perchFor, reduce, spriteState, frameIndex, type BirdState, type Mode } from "./machine";
import { layersWanted, lookFor, wantedFiles } from "./look";
import { feetOnBranch } from "./perch";
import { SPRITE_BUDGET_BYTES } from "./spriteCache";

const T0 = 1_000_000;
const start = (over: Partial<BirdState> = {}): BirdState => ({ ...initialState(T0, 1000, false, false, 0), branchDueAt: Infinity, ...over });
const tick = (s: BirdState, now: number) => reduce(s, { type: "tick" }, now, 0.5);
const frameNow = (s: BirdState, now: number) => frameIndex(s, now, (row, ms) => Math.min(rowOf(row).frames - 1, Math.floor((ms * rowOf(row).fps) / 1000)));
const lookNow = (s: BirdState, now: number) => lookFor(spriteState(s, now), frameNow(s, now), feetOnBranch(s, now));

describe("the bird's look where its feet are", () => {
  it("on the ground: the underband under the bird, nothing over it", () => {
    for (const row of ["idle", "walk", "peck", "talk", "pet"]) expect(lookFor(row, 0, false)).toEqual({ under: "underband", over: null });
  });

  it("on the branch: the front grip over the bird, no underband", () => {
    for (const row of ["idle", "perch", "sleep", "wake", "pet", "land", "takeoff"]) expect(lookFor(row, 0, true)).toEqual({ under: null, over: "frontGrip" });
  });

  it("in the air: neither", () => {
    for (const row of ["fly", "drag"]) {
      for (let f = 0; f < rowOf(row).frames; f++) expect(lookFor(row, f, false)).toEqual({ under: null, over: null });
    }
  });

  it("swaps on the same frame as the state: the land row on the branch has the grip from its first frame", () => {
    const up = beginFlight(start(), T0, perchFor(start()), true);
    const f = up.flight!;
    expect(lookNow(up, f.takeoffAt).under).toBe("underband"); // still on the ground
    expect(lookNow(up, f.flyAt + 50)).toEqual({ under: null, over: null }); // in the air
    for (let t = f.landRowAt; t < f.endAt; t += 10) expect(lookNow(up, t)).toEqual({ under: null, over: "frontGrip" });
    const on = tick(up, f.endAt);
    expect(on.onBranch).toBe(true);
    expect(lookNow(on, f.endAt).over).toBe("frontGrip");
    // Off again: the takeoff row on the branch, then the land row on the ground.
    const down = beginFlight(on, f.endAt + 1000, { x: 100, lift: 0 }, false);
    expect(lookNow(down, down.flight!.takeoffAt).over).toBe("frontGrip");
    expect(lookNow(down, down.flight!.endAt - 1)).toEqual({ under: "underband", over: null });
  });

  it("draws the underband, the bird and the grip on one frame, only once all are decoded: under, bird, then grip", () => {
    const bird = readFileSync(new URL("./bird.ts", import.meta.url), "utf8");
    expect(bird).toMatch(/if \(bitmap && \(!under \|\| underBitmap\) && \(!over \|\| overBitmap\) && ctx && gripCtx && backBirdCtx && backGripCtx && frameKey !== drawnFrame\)/);
    // Painted off screen in this order, then shown on both canvases together (paint.ts).
    expect(bird.indexOf("b.drawImage(underBitmap")).toBeLessThan(bird.indexOf("b.drawImage(bitmap"));
    expect(bird.indexOf("b.drawImage(bitmap")).toBeLessThan(bird.indexOf("g.drawImage(overBitmap"));
    expect(bird).toMatch(/const painted = paintBoth\(/);
  });

  it("every layer strip fits its cell; the underband has every grounded row, the grip every row drawn on the branch", () => {
    for (const scale of SCALES) {
      expect(Object.keys(scale.layers!).sort()).toEqual(["frontGrip", "underband"]);
      for (const layer of ["underband", "frontGrip"]) {
        for (const [state, { y, h }] of Object.entries(scale.layers![layer].rows)) {
          expect(y + h, `${layer} ${state}`).toBeLessThanOrEqual(scale.cell.height);
          expect(ROWS.some((r) => r.state === state)).toBe(true);
        }
      }
      for (const row of ["idle", "walk", "perch", "sleep", "takeoff", "land", "pet"]) expect(layerRect(scale, "underband", row, 0), `underband ${row}`).not.toBeNull();
      expect(Object.keys(scale.layers!.frontGrip.rows).sort()).toEqual(["happy", "idle", "idle_preen", "land", "perch", "pet", "sleep", "takeoff", "talk", "wake"]);
    }
  });
});

describe("decoded sprite memory with the layers", () => {
  const MODES: Mode[] = ["idle", "walk", "peck", "preen", "mutter", "perch", "sleep", "wake", "happy", "talk", "drag", "fall", "flight", "pet"];

  it("holds what any state may draw next, its layers included, within the 30 MB budget, at every scale", () => {
    let worst = 0;
    for (const scale of SCALES) {
      const sizes = scaleFiles(scale);
      for (const mode of MODES) {
        for (const onBranch of [false, true]) {
          const base = start({ mode, onBranch });
          const s = mode === "flight" ? { ...beginFlight(base, T0, perchFor(base), !onBranch), onBranch: false } : base;
          const files = wantedFiles(s, T0, scale);
          for (const f of files) expect(sizes.has(f), f).toBe(true);
          const bytes = files.reduce((n, f) => n + (sizes.get(f) ?? 0), 0);
          worst = Math.max(worst, bytes);
          expect(bytes, `${mode}${onBranch ? " on the branch" : ""} at ${scale.cell.width} px`).toBeLessThanOrEqual(SPRITE_BUDGET_BYTES);
        }
      }
    }
    console.log(`sprite memory with the layers, most any state asks for: ${(worst / 2 ** 20).toFixed(1)} MiB of ${SPRITE_BUDGET_BYTES / 2 ** 20}`);
    expect(layersWanted(start({ mode: "drag" }))).toEqual(["underband", "frontGrip"]);
  });
});
