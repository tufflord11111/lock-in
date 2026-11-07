import { describe, expect, it } from "vitest";
import { DISPLAY_CELL, frameAt, rowOf } from "./animator";
import {
  BOB_PX,
  FALL_PX_PER_S,
  LEAN_MAX_DEG,
  LEAN_MIN_DEG,
  STILL_STEP_MS,
  WALK_PX_PER_S,
  stepMs,
  walkPose,
  walkSpeed,
  frameIndex,
  holdsOneFrame,
  initialState,
  isStill,
  loopPlan,
  maxX,
  walkTarget,
  reduce,
  restingX,
  spriteState,
  type BirdEvent,
  type BirdState,
} from "./machine";

const WIDTH = 1000;
const T0 = 1_000_000;
const start = (over: Partial<BirdState> = {}): BirdState => ({
  ...initialState(T0, WIDTH, false, false, 0),
  ...over,
});
const go = (s: BirdState, e: BirdEvent, now = T0, rand = 0.5) => reduce(s, e, now, rand);
const tick = (s: BirdState, now: number, rand = 0.5) => go(s, { type: "tick" }, now, rand);
const byRow = (state: string, elapsed: number) => frameAt(rowOf(state), elapsed);

describe("awake", () => {
  it("boots idle on the bottom edge", () => {
    const s = start();
    expect(s.mode).toBe("idle");
    expect(s.lift).toBe(0);
    expect(s.x).toBe(restingX(WIDTH));
  });

  it("stays idle until its time is up, then moves on", () => {
    const s = start({ nextAt: T0 + 5000 });
    expect(tick(s, T0 + 4999)).toBe(s);
    expect(tick(s, T0 + 5000, 0.1).mode).toBe("walk");
    expect(tick(s, T0 + 5000, 0.6).mode).toBe("peck");
    expect(tick(s, T0 + 5000, 0.9).mode).toBe("perch");
  });

  it("walks at the art's stride, from the clock, and stops at its target", () => {
    const s = { ...start({ x: 100 }), mode: "walk", fromX: 100, targetX: 400, facing: 1, enteredAt: T0 } as BirdState;
    expect(tick(s, T0 + 2000).x).toBeCloseTo(100 + 2 * WALK_PX_PER_S);
    const done = tick(s, T0 + (300 / WALK_PX_PER_S) * 1000);
    expect(done.mode).toBe("idle");
    expect(done.x).toBe(400);
  });

  it("gets there after a long stall instead of walking off the edge", () => {
    const s = { ...start({ x: 100 }), mode: "walk", fromX: 100, targetX: 400, facing: 1, enteredAt: T0 } as BirdState;
    const late = tick(s, T0 + 3_600_000);
    expect(late.x).toBe(400);
    expect(late.mode).toBe("idle");
  });

  it("picks walk targets inside the overlay and faces them", () => {
    const s = start({ x: 500, nextAt: T0 });
    const right = tick(s, T0, 0.49);
    expect(right.mode).toBe("walk");
    expect(right.targetX).toBeLessThanOrEqual(maxX(WIDTH));
    expect(right.facing).toBe(1);
    const left = tick(s, T0, 0.05);
    expect(left.targetX).toBeGreaterThanOrEqual(0);
    expect(left.facing).toBe(-1);
  });

  it("comes back from a one-shot when it has played", () => {
    const s = { ...start(), mode: "peck", enteredAt: T0 } as BirdState;
    expect(tick(s, T0 + 100).mode).toBe("peck");
    expect(tick(s, T0 + 600).mode).toBe("idle");
  });
});

describe("sessions", () => {
  it("boots asleep if a session is already running", () => {
    expect(initialState(T0, WIDTH, false, true, 0).mode).toBe("sleep");
  });

  it("falls asleep when a session starts, and stays put", () => {
    const s = go(start(), { type: "session", active: true });
    expect(s.mode).toBe("sleep");
    expect(tick(s, T0 + 86_400_000)).toBe(s);
  });

  it("wakes happy when a session ran to its end", () => {
    let s = go(start(), { type: "session", active: true });
    s = go(s, { type: "stoodDown", finished: true });
    expect(s.mode).toBe("wake");
    s = tick(s, T0 + 500);
    expect(s.mode).toBe("happy");
    s = tick(s, T0 + 500 + 800);
    expect(s.mode).toBe("idle");
  });

  it("wakes without the celebration on any other ending", () => {
    let s = go(start(), { type: "session", active: true });
    s = go(s, { type: "stoodDown", finished: false });
    expect(s.mode).toBe("wake");
    s = tick(s, T0 + 500);
    expect(s.mode).toBe("idle");
  });

  it("is still happy if the poll woke it just before the event", () => {
    let s = go(start(), { type: "session", active: true });
    s = go(s, { type: "session", active: false });
    s = go(s, { type: "stoodDown", finished: true });
    expect(tick(s, T0 + 500).mode).toBe("happy");
  });

  it("goes back to sleep if a new session starts while it wakes", () => {
    let s = go(start(), { type: "session", active: true });
    s = go(s, { type: "stoodDown", finished: true });
    s = go(s, { type: "session", active: true });
    expect(s.mode).toBe("sleep");
  });

  it("a drop during a session lands asleep", () => {
    let s = go(start(), { type: "dragStart" });
    s = go(s, { type: "dragMove", x: 300, lift: 60, maxLift: 800 });
    s = go(s, { type: "session", active: true });
    expect(s.mode).toBe("drag");
    s = go(s, { type: "dragEnd" });
    expect(tick(s, T0 + 1000).mode).toBe("sleep");
  });

  it("the sleeping bird doesn't start talking", () => {
    const s = go(start(), { type: "session", active: true });
    expect(go(s, { type: "talkStart" }).mode).toBe("sleep");
  });
});

describe("talk", () => {
  it("returns to idle when the bubble goes", () => {
    let s = go(start(), { type: "talkStart" });
    expect(s.mode).toBe("talk");
    s = go(s, { type: "talkEnd" });
    expect(s.mode).toBe("idle");
  });
});

describe("drag and fall", () => {
  it("is clamped to the overlay and falls to the bottom edge from the clock", () => {
    let s = go(start(), { type: "dragStart" });
    s = go(s, { type: "dragMove", x: 99_999, lift: 300, maxLift: 800 });
    expect(s.x).toBe(maxX(WIDTH));
    s = go(s, { type: "dragMove", x: -50, lift: 300, maxLift: 800 });
    expect(s.x).toBe(0);
    s = go(s, { type: "dragEnd" }, T0);
    expect(s.mode).toBe("fall");
    expect(tick(s, T0 + 100).lift).toBeCloseTo(300 - FALL_PX_PER_S / 10);
    const landed = tick(s, T0 + 1000);
    expect(landed.lift).toBe(0);
    expect(landed.mode).toBe("idle");
  });

  it("uses the drag row while falling", () => {
    expect(spriteState({ ...start(), mode: "fall" })).toBe("drag");
    expect(spriteState({ ...start(), mode: "walk" })).toBe("walk");
  });
});

describe("the work area changing", () => {
  it("keeps the bird on it", () => {
    const s = go(start({ x: 900 }), { type: "resize", width: 500 });
    expect(s.x).toBe(maxX(500));
    expect(s.width).toBe(500);
  });

  it("abandons a walk whose end is now off screen", () => {
    const walking = { ...start({ x: 100 }), mode: "walk", targetX: 900, fromX: 100, enteredAt: T0 } as BirdState;
    expect(go(walking, { type: "resize", width: 500 }).mode).toBe("idle");
  });
});

describe("reduced motion", () => {
  it("never walks, sits at 85 %, and drops at once", () => {
    let s = initialState(T0, WIDTH, true, false, 0);
    expect(s.x).toBe(restingX(WIDTH));
    expect(restingX(WIDTH)).toBe(Math.round((WIDTH - DISPLAY_CELL.width) * 0.85));
    expect(tick(s, T0 + 10_000_000, 0.1)).toBe(s);
    s = go(s, { type: "dragStart" });
    s = go(s, { type: "dragMove", x: 50, lift: 200, maxLift: 800 });
    s = go(s, { type: "dragEnd" });
    expect(s.mode).toBe("idle");
    expect(s.lift).toBe(0);
  });

  it("holds frame 0 asleep and idle", () => {
    const idle = initialState(T0, WIDTH, true, false, 0);
    expect(frameIndex(idle, T0 + 12_345, byRow)).toBe(0);
    const asleep = initialState(T0, WIDTH, true, true, 0);
    expect(frameIndex(asleep, T0 + 12_345, byRow)).toBe(0);
  });

  it("can be switched on and off live", () => {
    const walking = { ...start({ x: 100 }), mode: "walk", enteredAt: T0 } as BirdState;
    const still = go(walking, { type: "reducedMotion", reduced: true });
    expect(still.mode).toBe("idle");
    expect(still.x).toBe(restingX(WIDTH));
    const back = go(still, { type: "reducedMotion", reduced: false }, T0 + 1000);
    expect(back.reducedMotion).toBe(false);
    expect(tick(back, back.nextAt, 0.1).mode).toBe("walk");
  });
});

describe("what the loop needs", () => {
  it("still modes need no frames", () => {
    expect(isStill(start())).toBe(true);
    expect(isStill({ ...start(), mode: "sleep" })).toBe(true);
    expect(isStill({ ...start(), mode: "perch" })).toBe(true);
    expect(isStill({ ...start(), mode: "walk" })).toBe(false);
    expect(isStill({ ...start(), mode: "fall" })).toBe(false);
  });

  it("still modes change frame at most once a second", () => {
    expect(STILL_STEP_MS).toBeGreaterThanOrEqual(1000);
    const s = { ...start(), mode: "perch" } as BirdState;
    const frames = rowOf("perch").frames;
    expect(frameIndex(s, T0 + 999, byRow)).toBe(0);
    expect(frameIndex(s, T0 + 1000, byRow)).toBe(1);
    expect(frameIndex(s, T0 + frames * 1000, byRow)).toBe(0);
  });

  it("moving modes follow the row's own fps", () => {
    const s = { ...start(), mode: "walk", fromX: 0, targetX: 900, enteredAt: T0 } as BirdState;
    expect(frameIndex(s, T0 + 300, byRow)).toBe(3);
  });

  it("hiding changes nothing but the flag", () => {
    const s = go(start(), { type: "hidden", hidden: true });
    expect(s.hidden).toBe(true);
    expect(s.mode).toBe("idle");
  });
});

describe("walks and drags stay on the screen and reach its edges", () => {
  it("a walk can end exactly on either edge", () => {
    expect(walkTarget(0, WIDTH)).toBe(0);
    expect(walkTarget(0.14, WIDTH)).toBe(0);
    expect(walkTarget(0.86, WIDTH)).toBe(maxX(WIDTH));
    expect(walkTarget(0.999, WIDTH)).toBe(maxX(WIDTH));
  });

  it("between the edge bands, a walk ends somewhere in between", () => {
    const t = walkTarget(0.5, WIDTH);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(maxX(WIDTH));
  });

  it("both edges turn up within a modest number of walks", () => {
    let seed = 1;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const targets = Array.from({ length: 40 }, () => walkTarget(rand(), WIDTH));
    expect(targets).toContain(0);
    expect(targets).toContain(maxX(WIDTH));
  });

  it("dragging past the top keeps the whole bird on the screen", () => {
    let s = go(start(), { type: "dragStart" });
    s = go(s, { type: "dragMove", x: 100, lift: 99_999, maxLift: 804 });
    expect(s.lift).toBe(804);
    s = go(s, { type: "dragMove", x: 100, lift: -50, maxLift: 804 });
    expect(s.lift).toBe(0);
  });
});

describe("asleep, nothing redraws", () => {
  it("holds one frame however long it sleeps, with motion allowed", () => {
    const asleep = initialState(T0, WIDTH, false, true, 0);
    expect(holdsOneFrame(asleep)).toBe(true);
    for (const later of [0, 1_000, 2_000, 60_000]) {
      expect(frameIndex(asleep, T0 + later, byRow)).toBe(0);
    }
  });

  it("an awake still bird keeps stepping", () => {
    const idle = initialState(T0, WIDTH, false, false, 0);
    expect(holdsOneFrame(idle)).toBe(false);
  });
});

describe("what the loop plans", () => {
  it("stops asleep and while hidden", () => {
    expect(loopPlan(initialState(T0, WIDTH, false, true, 0), T0).kind).toBe("stop");
    expect(loopPlan({ ...start(), hidden: true }, T0).kind).toBe("stop");
  });

  it("walks on a timer, never rAF", () => {
    const walking = { ...start(), mode: "walk" } as BirdState;
    expect(loopPlan(walking, T0)).toEqual({ kind: "wait", ms: 1000 / 15 });
  });

  it("uses rAF only for what must follow closely", () => {
    expect(loopPlan({ ...start(), mode: "drag" } as BirdState, T0).kind).toBe("frames");
    expect(loopPlan({ ...start(), mode: "fall" } as BirdState, T0).kind).toBe("frames");
  });

  it("steps an awake still bird once a second", () => {
    const idle = { ...start(), mode: "idle", enteredAt: T0 } as BirdState;
    expect(loopPlan(idle, T0 + 250)).toEqual({ kind: "wait", ms: 750 });
  });
});

describe("a cell that isn't square", () => {
  const WIDE = { width: 128, height: 80 };
  const wide = (over: Partial<BirdState> = {}): BirdState => ({ ...initialState(T0, WIDTH, false, false, 0, WIDE), ...over });

  it("rests, walks and stops by the cell's width, never its height", () => {
    expect(maxX(WIDTH, WIDE)).toBe(WIDTH - 128);
    expect(restingX(WIDTH, WIDE)).toBe(Math.round((WIDTH - 128) * 0.85));
    expect(wide().x).toBe(restingX(WIDTH, WIDE));
    expect(walkTarget(0.999, WIDTH, WIDE)).toBe(WIDTH - 128);
    expect(walkTarget(0.5, WIDTH, WIDE)).toBeLessThanOrEqual(WIDTH - 128);
  });

  it("walks to the right edge and stands flush with it", () => {
    let s = tick(wide({ nextAt: T0 }), T0, 0.999 / 2);
    expect(s.mode).toBe("walk");
    expect(s.targetX).toBe(WIDTH - 128);
    s = tick(s, T0 + 1_000_000);
    expect(s.x).toBe(WIDTH - 128);
    expect(s.mode).toBe("idle");
  });

  it("clamps a drag by the cell's width, and keeps the cell on a resize", () => {
    let s = go(wide(), { type: "dragStart" });
    s = go(s, { type: "dragMove", x: 99_999, lift: 10, maxLift: 800 });
    expect(s.x).toBe(WIDTH - 128);
    s = go(s, { type: "resize", width: 500 });
    expect(s.x).toBe(500 - 128);
    expect(s.cell).toEqual(WIDE);
  });
});

describe("the walk, smoothed in code", () => {
  const walk = rowOf("walk");
  const walking = (over: Partial<BirdState> = {}): BirdState =>
    ({ ...start({ x: 100 }), mode: "walk", fromX: 100, targetX: 900, facing: 1, enteredAt: T0, ...over }) as BirdState;

  it("goes at the stride times the fps, so the planted foot keeps pace with the ground", () => {
    expect(walk.stride).toBeGreaterThan(0);
    expect(walkSpeed()).toBe(walk.stride! * walk.fps);
    expect(walkSpeed({ ...walk, stride: 3, fps: 8 })).toBe(24);
    expect(() => walkSpeed({ ...walk, stride: undefined })).toThrow();
  });

  it("travels exactly one stride per sprite frame, on the same clock, in sub-pixel steps", () => {
    const frameMs = 1000 / walk.fps;
    for (let n = 1; n <= 6; n++) {
      const at = T0 + n * frameMs;
      expect(frameAt(walk, at - T0)).toBe(n % walk.frames);
      expect(tick(walking(), at).x).toBeCloseTo(100 + n * walk.stride!, 9);
    }
    // Between frames on the 15 fps timer it is wherever the clock puts it, not rounded.
    const between = tick(walking(), T0 + 1000 / 15).x - 100;
    expect(between).toBeCloseTo((walkSpeed() * (1000 / 15)) / 1000, 9);
    expect(Number.isInteger(between)).toBe(false);
  });

  it("bobs up to BOB_PX and back each step, eased at both ends", () => {
    const step = stepMs();
    expect(step).toBe((walk.frames * 1000) / walk.fps / 2);
    const at = (f: number) => walkPose(walking(), T0 + f * step);
    expect(at(0).bob).toBeCloseTo(0, 9);
    expect(at(0.5).bob).toBeCloseTo(BOB_PX, 9);
    expect(at(1).bob).toBeCloseTo(0, 9);
    expect(at(0.25).bob).toBeCloseTo(at(0.75).bob, 9);
    // Eased: it barely moves near the ends of a step and fastest in the middle.
    expect(at(0.05).bob).toBeLessThan(0.1);
    expect(at(0.3).bob - at(0.25).bob).toBeGreaterThan(at(0.05).bob - at(0).bob);
    for (let f = 0; f <= 1; f += 0.05) {
      expect(at(f).bob).toBeGreaterThanOrEqual(0);
      expect(at(f).bob).toBeLessThanOrEqual(BOB_PX + 1e-9);
    }
    expect(BOB_PX).toBeGreaterThanOrEqual(2);
    expect(BOB_PX).toBeLessThanOrEqual(3);
  });

  it("leans 1 to 2 degrees toward where it is going", () => {
    const step = stepMs();
    for (let f = 0; f <= 1; f += 0.1) {
      const right = walkPose(walking(), T0 + f * step).lean;
      const left = walkPose(walking({ facing: -1 }), T0 + f * step).lean;
      expect(right).toBeGreaterThanOrEqual(LEAN_MIN_DEG - 1e-9);
      expect(right).toBeLessThanOrEqual(LEAN_MAX_DEG + 1e-9);
      expect(left).toBeCloseTo(-right, 9);
    }
    expect([LEAN_MIN_DEG, LEAN_MAX_DEG]).toEqual([1, 2]);
  });

  it("does nothing outside a walk, under reduced motion, or asleep, and asleep still asks for no redraw", () => {
    expect(walkPose(walking({ reducedMotion: true }), T0 + 100)).toEqual({ bob: 0, lean: 0 });
    expect(walkPose(start(), T0 + 100)).toEqual({ bob: 0, lean: 0 });
    const asleep = initialState(T0, WIDTH, false, true, 0);
    expect(walkPose(asleep, T0 + 100)).toEqual({ bob: 0, lean: 0 });
    expect(loopPlan(asleep, T0 + 100).kind).toBe("stop");
  });
});
