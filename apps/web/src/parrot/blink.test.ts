import { describe, expect, it } from "vitest";
import { STILL_STEP_MS, initialState, loopPlan } from "./machine";
import { DISPLAY_CELL, eyeAt, type Eye, type SheetScale } from "./animator";
import {
  BLINK_MAX_GAP_MS,
  BLINK_MIN_GAP_MS,
  BLINK_MS,
  BLINK_ROWS,
  DOUBLE_CHANCE,
  DOUBLE_GAP_MS,
  LID_STEP_MS,
  blinkGap,
  blinkLength,
  blinkPlan,
  canBlink,
  combinePlans,
  firstBlink,
  lidAt,
  lidBox,
  lidOver,
  stepBlink,
  type Blink,
} from "./blink";

const T0 = 1_000_000;
const awake = { mode: "idle", reducedMotion: false, hidden: false };
const running = (double = false): Blink => ({ nextAt: T0, startAt: T0, double });
const OPEN: Eye = { x: 114, y: 32, r: 2.8, open: true };

describe("when it blinks", () => {
  it("waits 3 to 7 s between blinks, at random", () => {
    expect(blinkGap(0)).toBe(3_000);
    expect(blinkGap(1)).toBe(7_000);
    expect(blinkGap(0.5)).toBe(5_000);
    expect([BLINK_MIN_GAP_MS, BLINK_MAX_GAP_MS]).toEqual([3_000, 7_000]);
    expect(firstBlink(T0, 0.25).nextAt).toBe(T0 + 4_000);
  });

  it("closes over ~150 ms: half, closed, half, then open", () => {
    expect(BLINK_MS).toBe(150);
    const b = running();
    const at = (ms: number) => lidAt(b, T0 + ms);
    expect([0, LID_STEP_MS - 1].map(at)).toEqual([0.5, 0.5]);
    expect([LID_STEP_MS, 2 * LID_STEP_MS - 1].map(at)).toEqual([1, 1]);
    expect([2 * LID_STEP_MS, BLINK_MS - 1].map(at)).toEqual([0.5, 0.5]);
    expect(at(BLINK_MS)).toBe(0);
    expect(lidAt({ ...b, startAt: null }, T0 + 60)).toBe(0);
  });

  it("does a double blink with a short open gap, one time in five", () => {
    expect(DOUBLE_CHANCE).toBe(0.2);
    const d = running(true);
    const at = (ms: number) => lidAt(d, T0 + ms);
    expect(at(60)).toBe(1);
    expect(at(BLINK_MS + 10)).toBe(0);
    expect(at(BLINK_MS + DOUBLE_GAP_MS - 1)).toBe(0);
    expect(at(BLINK_MS + DOUBLE_GAP_MS)).toBe(0.5);
    expect(at(BLINK_MS + DOUBLE_GAP_MS + 60)).toBe(1);
    expect(at(blinkLength(true))).toBe(0);
    expect(blinkLength(true)).toBe(400);
    const due: Blink = { nextAt: T0, startAt: null, double: false };
    expect(stepBlink(due, T0, true, 0.5, 0.19).double).toBe(true);
    expect(stepBlink(due, T0, true, 0.5, 0.2).double).toBe(false);
  });

  it("starts when due, holds while running, and schedules the next 3 to 7 s after it ends", () => {
    let b = firstBlink(T0, 0);
    expect(stepBlink(b, T0 + 2_999, true, 0.5, 0.9)).toBe(b);
    b = stepBlink(b, T0 + 3_000, true, 0.5, 0.9);
    expect(b.startAt).toBe(T0 + 3_000);
    expect(stepBlink(b, T0 + 3_100, true, 0.5, 0.9)).toBe(b);
    const after = stepBlink(b, T0 + 3_150, true, 0.5, 0.9);
    expect(after.startAt).toBeNull();
    expect(after.nextAt).toBe(T0 + 3_150 + 5_000);
  });

  it("spaces blinks 3 to 7 s apart over a long run", () => {
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let b = firstBlink(T0, rand());
    const starts: number[] = [];
    for (let t = T0; t < T0 + 120_000; t += 33) {
      const next = stepBlink(b, t, true, rand(), rand());
      if (next.startAt !== null && b.startAt === null) starts.push(t);
      b = next;
    }
    expect(starts.length).toBeGreaterThan(120 / 7.5);
    starts.slice(1).forEach((t, i) => {
      const gap = t - starts[i];
      expect(gap).toBeGreaterThanOrEqual(BLINK_MIN_GAP_MS + BLINK_MS - 1);
      expect(gap).toBeLessThanOrEqual(BLINK_MAX_GAP_MS + blinkLength(true) + 34);
    });
  });
});

describe("where it never blinks", () => {
  it("blinks only in idle, walk, talk, peck and perch", () => {
    expect([...BLINK_ROWS]).toEqual(["idle", "walk", "talk", "peck", "perch"]);
    for (const row of BLINK_ROWS) expect(canBlink({ ...awake, mode: row }, row)).toBe(true);
    for (const row of ["sleep", "wake", "happy", "drag", "idle_blink", "idle_preen", "yawn"]) {
      expect(canBlink({ ...awake, mode: row }, row), row).toBe(false);
    }
  });

  it("never asleep, hidden or under reduced motion", () => {
    expect(canBlink({ ...awake, mode: "sleep" }, "idle")).toBe(false);
    expect(canBlink({ ...awake, reducedMotion: true }, "idle")).toBe(false);
    expect(canBlink({ ...awake, hidden: true }, "idle")).toBe(false);
  });

  it("skips a blink that comes due when it can't, without drawing it", () => {
    const due: Blink = { nextAt: T0, startAt: null, double: false };
    const skipped = stepBlink(due, T0 + 10, false, 0, 0);
    expect(skipped.startAt).toBeNull();
    expect(skipped.nextAt).toBe(T0 + 10 + 3_000);
    expect(lidAt(skipped, T0 + 20)).toBe(0);
  });

  it("stops a running blink at once if the bird falls asleep or hides", () => {
    const b = stepBlink(running(), T0 + 60, false, 0, 0);
    expect(b.startAt).toBeNull();
    expect(lidAt(b, T0 + 61)).toBe(0);
  });
});

describe("the skip rule: only over an eye the art shows open", () => {
  it("draws over an open eye, at half and closed", () => {
    expect(lidOver(OPEN, 0.5)).toEqual({ eye: OPEN, lid: 0.5 });
    expect(lidOver(OPEN, 1)).toEqual({ eye: OPEN, lid: 1 });
  });

  it("draws nothing where the eye is shut, null, missing, or the lid is up", () => {
    expect(lidOver({ ...OPEN, open: false }, 1)).toBeNull();
    expect(lidOver(null, 1)).toBeNull();
    expect(lidOver(undefined, 1)).toBeNull();
    expect(lidOver(OPEN, 0)).toBeNull();
  });

  it("reads the eye at the current scale, in display px, and nothing for rows or frames it lacks", () => {
    const k = 2;
    const scale: SheetScale = {
      maxDpr: null,
      cell: { width: DISPLAY_CELL.width * k, height: DISPLAY_CELL.height * k },
      sheet: { width: 0, height: 0 },
      eyes: { talk: [{ x: 250, y: 66, r: 5.6, open: true }, null, { x: 249.8, y: 64, r: 3.1, open: false }] },
    };
    expect(eyeAt(scale, "talk", 0)).toEqual({ x: 125, y: 33, r: 2.8, open: true });
    expect(eyeAt(scale, "talk", 1)).toBeNull();
    expect(lidOver(eyeAt(scale, "talk", 2), 1)).toBeNull();
    expect(eyeAt(scale, "talk", 9)).toBeNull();
    expect(eyeAt(scale, "sleep", 0)).toBeNull();
    expect(eyeAt({ ...scale, eyes: undefined }, "talk", 0)).toBeNull();
  });

  it("covers the eye's rim, half down to its middle and closed down to its bottom", () => {
    const half = lidBox(OPEN, 0.5);
    const shut = lidBox(OPEN, 1);
    expect(half.size).toBeCloseTo(2 * 1.25 * OPEN.r);
    expect(half.left + half.size / 2).toBeCloseTo(OPEN.x);
    expect(half.top + half.fill).toBeCloseTo(OPEN.y);
    expect(shut.top + shut.fill).toBeCloseTo(OPEN.y + OPEN.r);
  });
});

describe("what the blink asks of the loop", () => {
  it("asleep: nothing at all, so the loop still stops and nothing redraws", () => {
    const asleep = initialState(T0, 1000, false, true, 0);
    const eligible = canBlink(asleep, "sleep");
    expect(eligible).toBe(false);
    expect(combinePlans(loopPlan(asleep, T0), blinkPlan(firstBlink(T0, 0), T0, eligible))).toEqual({ kind: "stop" });
    expect(combinePlans(loopPlan(asleep, T0), blinkPlan(running(), T0, eligible))).toEqual({ kind: "stop" });
  });

  it("under reduced motion: nothing, so the held pose stays held", () => {
    const still = initialState(T0, 1000, true, false, 0);
    expect(combinePlans(loopPlan(still, T0), blinkPlan(firstBlink(T0, 0), T0, canBlink(still, "idle")))).toEqual({ kind: "stop" });
  });

  it("awake: a wake-up when the next blink is due, and every frame while it runs", () => {
    const idle = initialState(T0, 1000, false, false, 0);
    const soon: Blink = { nextAt: T0 + 400, startAt: null, double: false };
    expect(combinePlans(loopPlan(idle, T0), blinkPlan(soon, T0, true))).toEqual({ kind: "wait", ms: 400 });
    const later: Blink = { nextAt: T0 + 5_000, startAt: null, double: false };
    expect(combinePlans(loopPlan(idle, T0), blinkPlan(later, T0, true))).toEqual({ kind: "wait", ms: STILL_STEP_MS });
    expect(combinePlans(loopPlan(idle, T0), blinkPlan(running(), T0, true))).toEqual({ kind: "frames" });
  });

  it("combines plans: frames win, then the sooner wait, then stop", () => {
    expect(combinePlans({ kind: "stop" }, { kind: "stop" })).toEqual({ kind: "stop" });
    expect(combinePlans({ kind: "wait", ms: 5 }, { kind: "stop" })).toEqual({ kind: "wait", ms: 5 });
    expect(combinePlans({ kind: "stop" }, { kind: "wait", ms: 7 })).toEqual({ kind: "wait", ms: 7 });
    expect(combinePlans({ kind: "wait", ms: 5 }, { kind: "wait", ms: 3 })).toEqual({ kind: "wait", ms: 3 });
    expect(combinePlans({ kind: "wait", ms: 5 }, { kind: "frames" })).toEqual({ kind: "frames" });
  });
});
