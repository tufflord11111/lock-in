import { describe, expect, it } from "vitest";
import { DISPLAY_CELL, frameAt, rowOf } from "./animator";
import {
  FALL_PX_PER_S,
  STILL_STEP_MS,
  WALK_PX_PER_S,
  WALK_STEP_MS,
  WALK_TICK_FPS,
  TURN_DIP_PX,
  TURN_MIN_SCALE,
  TURN_MS,
  contactFrames,
  faceTo,
  isTurning,
  turnPose,
  walkStepsFor,
  walkDistance,
  walkTime,
  beginWalk,
  enterRest,
  pickFidget,
  restLength,
  walkLength,
  mix,
  FIDGETS,
  FIDGET_LONGEST_MS,
  KEEP_GOING,
  MUTTER_MS,
  PERCH_CHANCE,
  REST_MAX_MS,
  REST_MIN_MS,
  WALK_MAX_MS,
  WALK_MIN_MS,
  type Mode,
  walkSpeed,
  walkStride,
  frameIndex,
  holdsOneFrame,
  initialState,
  isStill,
  loopPlan,
  maxX,
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

  it("rests until its next moment, fidgets within the rest, and walks when the rest is over", () => {
    const s = start({ nextAt: T0 + 5000, restUntil: T0 + 15_000 });
    expect(tick(s, T0 + 4999)).toBe(s);
    const fidget = tick(s, T0 + 5000, 0.3);
    expect(["peck", "preen", "mutter"]).toContain(fidget.mode);
    expect(fidget.restUntil).toBe(T0 + 15_000);
    expect(tick(start({ nextAt: T0, restUntil: T0 }), T0, 0.3).mode).toBe("walk");
  });

  it("walks at the art's stride, from the clock, and stops at its target", () => {
    const steps = 60;
    const target = 100 + steps * walkStride();
    const s = { ...start({ x: 100 }), mode: "walk", fromX: 100, targetX: target, facing: 1, enteredAt: T0, stepAt: T0, walkSteps: steps } as BirdState;
    expect(tick(s, T0 + 2000).x).toBeCloseTo(100 + 2 * WALK_PX_PER_S);
    const done = tick(s, T0 + ((steps + 1) * 1000) / rowOf("walk").fps + 1);
    expect(["idle", "perch"]).toContain(done.mode);
    expect(done.x).toBe(target);
  });

  it("gets there after a long stall instead of walking off the edge", () => {
    const target = 100 + 60 * walkStride();
    const s = { ...start({ x: 100 }), mode: "walk", fromX: 100, targetX: target, facing: 1, enteredAt: T0, stepAt: T0, walkSteps: 60 } as BirdState;
    const late = tick(s, T0 + 3_600_000);
    expect(late.x).toBe(target);
    expect(["idle", "perch"]).toContain(late.mode);
  });

  it("walks the way it is sent, inside the overlay, facing where it goes", () => {
    const s = start({ x: 500 });
    const right = beginWalk(s, T0, 1, 2500)!;
    expect(right.mode).toBe("walk");
    expect(right.targetX).toBeGreaterThan(500);
    expect(right.targetX).toBeLessThanOrEqual(maxX(WIDTH));
    expect(right.facing).toBe(1);
    const left = beginWalk(s, T0, -1, 2500)!;
    expect(left.targetX).toBeLessThan(500);
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
    expect(spriteState({ ...start(), mode: "fall" }, T0)).toBe("drag");
    expect(spriteState({ ...start(), mode: "walk", stepAt: T0 }, T0)).toBe("walk");
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
    expect(back.restUntil).toBeGreaterThan(T0 + 1000);
    expect(tick({ ...back, mode: "idle", nextAt: back.restUntil }, back.restUntil, 0.3).mode).toBe("walk");
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
    const s = { ...start(), mode: "walk", fromX: 0, targetX: 900, enteredAt: T0, stepAt: T0, walkSteps: 99 } as BirdState;
    const walk = rowOf("walk");
    expect(frameIndex(s, T0 + 3 * (1000 / walk.fps) + 1, byRow)).toBe(3 % walk.frames);
  });

  it("hiding changes nothing but the flag", () => {
    const s = go(start(), { type: "hidden", hidden: true });
    expect(s.hidden).toBe(true);
    expect(s.mode).toBe("idle");
  });
});

describe("walks and drags stay on the screen and reach its edges", () => {
  it("a walk never ends off the screen, from anywhere, either way", () => {
    for (let x = 0; x <= maxX(WIDTH); x += 37) {
      for (const facing of [1, -1] as const) {
        for (const d of [1000, 2500, 4000]) {
          const w = beginWalk(start({ x }), T0, facing, d);
          if (!w) continue;
          expect(w.targetX).toBeGreaterThanOrEqual(0);
          expect(w.targetX).toBeLessThanOrEqual(maxX(WIDTH));
        }
      }
    }
  });

  it("near an edge it turns back, or rests if neither way has room for a walk", () => {
    const atRight = start({ x: maxX(WIDTH), facing: 1, nextAt: T0, restUntil: T0 });
    const w = tick(atRight, T0, 0.01);
    expect(w.mode).toBe("walk");
    expect(w.facing).toBe(-1);
    // A window too narrow for even the shortest walk: it rests again.
    const narrow = start({ width: DISPLAY_CELL.width + 10, x: 5, nextAt: T0, restUntil: T0 });
    expect(["idle", "perch"]).toContain(tick(narrow, T0, 0.5).mode);
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
    const w = beginWalk(wide({ x: WIDTH - 128 - 60 }), T0, 1, 4000)!;
    expect(w.targetX).toBeLessThanOrEqual(WIDTH - 128);
  });

  it("walking right toward the edge stops on a contact frame without passing it", () => {
    let s = beginWalk(wide({ x: WIDTH - 128 - 120 }), T0, 1, 4000)!;
    expect(s.mode).toBe("walk");
    expect(s.targetX).toBeLessThanOrEqual(WIDTH - 128);
    expect(contactFrames()).toContain(s.walkSteps % rowOf("walk").frames);
    s = tick(s, T0 + 1_000_000);
    expect(s.x).toBe(s.targetX);
    expect(["idle", "perch"]).toContain(s.mode);
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

describe("the walk, locked to the art's frames", () => {
  const walk = rowOf("walk");
  const walking = (over: Partial<BirdState> = {}): BirdState =>
    ({ ...start({ x: 100 }), mode: "walk", fromX: 100, targetX: 900, facing: 1, enteredAt: T0, stepAt: T0, walkSteps: 160, ...over }) as BirdState;
  const frameMs = 1000 / walk.fps;

  it("plays at a rate that divides the 15 fps walk timer, so every frame shows for the same ticks", () => {
    const ticksPerFrame = WALK_TICK_FPS / walk.fps;
    expect(Number.isInteger(ticksPerFrame)).toBe(true);
    // On the timer's own ticks the frame changes every ticksPerFrame ticks, never early or late.
    const frames = Array.from({ length: 24 }, (_, k) => frameAt(walk, k * WALK_STEP_MS + 0.5));
    frames.forEach((f, k) => expect(f).toBe(Math.floor(k / ticksPerFrame) % walk.frames));
  });

  it("goes at the stride times the fps", () => {
    expect(walkStride()).toBe(walk.stride);
    expect(walkSpeed()).toBe(walk.stride! * walk.fps);
    expect(walkSpeed({ ...walk, stride: 5, fps: 7.5 })).toBe(37.5);
    expect(() => walkStride({ ...walk, stride: undefined })).toThrow();
  });

  it("moves one stride when the frame changes and not in between, so the planted foot stays put", () => {
    for (let n = 0; n <= 6; n++) {
      const frameStart = T0 + n * frameMs;
      expect(frameAt(walk, frameStart - T0 + 1)).toBe(n % walk.frames);
      // The whole frame, from its first ms to its last, at the same x.
      expect(tick(walking(), frameStart + 1).x).toBe(100 + n * walk.stride!);
      expect(tick(walking(), frameStart + frameMs - 1).x).toBe(100 + n * walk.stride!);
    }
    expect(walkDistance(-50)).toBe(0);
  });

  it("still stops exactly at its target", () => {
    const s = walking({ targetX: 100 + 8 * walk.stride!, walkSteps: 8 });
    const done = tick(s, T0 + 9 * frameMs + 1);
    expect(["idle", "perch"]).toContain(done.mode);
    expect(done.x).toBe(100 + 8 * walk.stride!);
  });
});

describe("turning round", () => {
  const facingRight = (over: Partial<BirdState> = {}) => start({ x: 400, facing: 1, ...over });

  it("never flips at once: the old facing is still drawn when the turn begins", () => {
    const s = faceTo(facingRight(), -1, T0);
    expect(s.facing).toBe(-1);
    expect(turnPose(s, T0).scaleX).toBe(1);
    expect(isTurning(s, T0)).toBe(true);
  });

  it("squeezes to 0.08 over 80 ms, flips, and opens out over the next 80 ms, eased", () => {
    const s = faceTo(facingRight(), -1, T0);
    const at = (ms: number) => turnPose(s, T0 + ms);
    expect(TURN_MS).toBe(160);
    expect(at(0).scaleX).toBeCloseTo(1, 9);
    expect(at(79.999).scaleX).toBeCloseTo(TURN_MIN_SCALE, 3);
    expect(at(80).scaleX).toBeCloseTo(-TURN_MIN_SCALE, 9);
    expect(at(159.999).scaleX).toBeCloseTo(-1, 3);
    expect(at(160)).toEqual({ scaleX: -1, dip: 0 });
    // Eased: slow at the ends, quick in the middle of each half.
    expect(1 - at(8).scaleX).toBeLessThan(at(36).scaleX - at(44).scaleX);
    // Shrinks through the first half, grows through the second.
    for (let t = 0; t < 79; t += 4) expect(Math.abs(at(t + 4).scaleX)).toBeLessThanOrEqual(Math.abs(at(t).scaleX) + 1e-9);
    for (let t = 80; t < 156; t += 4) expect(Math.abs(at(t + 4).scaleX)).toBeGreaterThanOrEqual(Math.abs(at(t).scaleX) - 1e-9);
  });

  it("dips 2 px at the midpoint, and none at either end", () => {
    const s = faceTo(facingRight(), -1, T0);
    expect(TURN_DIP_PX).toBe(2);
    expect(turnPose(s, T0).dip).toBeCloseTo(0, 9);
    expect(turnPose(s, T0 + 80).dip).toBeCloseTo(2, 9);
    expect(turnPose(s, T0 + 40).dip).toBeGreaterThan(0);
    expect(turnPose(s, T0 + 40).dip).toBeLessThan(2);
    expect(turnPose(s, T0 + 160).dip).toBe(0);
  });

  it("turns left to right the same way", () => {
    const s = faceTo(start({ facing: -1 }), 1, T0);
    expect(turnPose(s, T0).scaleX).toBe(-1);
    expect(turnPose(s, T0 + 80).scaleX).toBeCloseTo(TURN_MIN_SCALE, 9);
    expect(turnPose(s, T0 + 160).scaleX).toBe(1);
  });

  it("doesn't move the bird while it turns", () => {
    let s = beginWalk(facingRight({ x: 600 }), T0, -1, 2500)!; // a walk to the left
    expect(s.mode).toBe("walk");
    expect(s.facing).toBe(-1);
    for (let t = 0; t <= TURN_MS; t += 10) expect(tick(s, T0 + t).x).toBe(600);
    s = tick(s, T0 + TURN_MS);
    expect(s.x).toBe(600);
  });

  it("asks the loop for every frame while it turns", () => {
    const s = faceTo(facingRight(), -1, T0);
    expect(loopPlan(s, T0 + 50)).toEqual({ kind: "frames" });
  });

  it("just flips under reduced motion", () => {
    const s = faceTo(facingRight({ reducedMotion: true }), -1, T0);
    expect(s.turnStart).toBeNull();
    expect(turnPose(s, T0)).toEqual({ scaleX: -1, dip: 0 });
  });

  it("is not drawn asleep or hidden, so the sleeping bird still asks for no redraw", () => {
    const turning = faceTo(facingRight(), -1, T0);
    const asleep = go(turning, { type: "session", active: true }, T0 + 20);
    expect(turnPose(asleep, T0 + 30)).toEqual({ scaleX: -1, dip: 0 });
    expect(loopPlan(asleep, T0 + 30).kind).toBe("stop");
    expect(turnPose({ ...turning, hidden: true }, T0 + 30).scaleX).toBe(-1);
  });

  it("keeps facing as it is when nothing changes", () => {
    const s = facingRight();
    expect(faceTo(s, 1, T0)).toBe(s);
  });
});

describe("starting and stopping a walk", () => {
  const walk = rowOf("walk");
  const frameMs = 1000 / walk.fps;
  const leftFrom = (x: number) => beginWalk(start({ x, facing: 1 }), T0, -1, 3000)!;
  const rightFrom = (x: number) => beginWalk(start({ x, facing: 1 }), T0, 1, 3000)!;

  it("turns first, keeping the drawing it had, then starts the walk", () => {
    const s = leftFrom(700);
    expect(s.stepAt).toBe(T0 + TURN_MS);
    for (const t of [0, 50, 159]) {
      expect(spriteState(s, T0 + t)).toBe("idle");
      expect(frameIndex(s, T0 + t, byRow)).toBe(s.holdFrame);
    }
    expect(spriteState(s, T0 + TURN_MS)).toBe("walk");
    expect(frameIndex(s, T0 + TURN_MS, byRow)).toBe(0);
  });

  it("with no turn to make, shows walk frame 0 at once", () => {
    const s = rightFrom(100);
    expect(s.facing).toBe(1);
    expect(s.stepAt).toBe(T0);
    expect(spriteState(s, T0)).toBe("walk");
    expect(frameIndex(s, T0, byRow)).toBe(0);
  });

  it("holds walk frame 0 for one frame-time without moving, then steps a stride per frame", () => {
    for (const s of [leftFrom(700), rightFrom(100)]) {
      const from = s.x;
      // The first frame-time: frame 0, not moving.
      expect(tick(s, s.stepAt + 1).x).toBe(from);
      expect(tick(s, s.stepAt + frameMs - 1).x).toBe(from);
      expect(frameIndex(s, s.stepAt + frameMs - 1, byRow)).toBe(0);
      // Then frame 1, one stride on. (1 ms past each boundary: k x 133.33 ms is not exact in floats.)
      expect(frameIndex(s, s.stepAt + frameMs + 1, byRow)).toBe(1);
      expect(tick(s, s.stepAt + frameMs + 1).x).toBe(from + s.facing * walkStride());
    }
  });

  it("stops on a contact frame at its target, holds it one frame-time, then idles", () => {
    for (const s of [leftFrom(700), rightFrom(100)]) {
      const k = s.walkSteps;
      expect(contactFrames()).toContain(k % walk.frames);
      expect(s.targetX).toBe(s.fromX + s.facing * k * walkStride());
      const arrive = s.stepAt + k * frameMs;
      const there = tick(s, arrive + 1);
      expect(there.mode).toBe("walk");
      expect(there.x).toBe(s.targetX);
      expect(frameIndex(s, arrive + 1, byRow)).toBe(k % walk.frames);
      // Still that contact frame, still walking, to the end of its frame-time.
      expect(tick(s, arrive + frameMs - 1).mode).toBe("walk");
      expect(frameIndex(s, arrive + frameMs - 1, byRow)).toBe(k % walk.frames);
      const done = tick(s, arrive + frameMs + 1);
      expect(["idle", "perch"]).toContain(done.mode);
      expect(done.x).toBe(s.targetX);
    }
  });

  it("only ever plans walks that end on a contact frame and stay on the screen", () => {
    expect(contactFrames({ ...walk, frames: 8, contact: undefined })).toEqual([0, 4]);
    expect(contactFrames({ ...walk, contact: [2, 6] })).toEqual([2, 6]);
    for (let d = WALK_MIN_MS; d <= WALK_MAX_MS; d += 250) {
      for (const facing of [1, -1] as const) {
        for (const turned of [false, true]) {
          const k = walkStepsFor(d, 500, facing, turned, WIDTH, DISPLAY_CELL);
          if (k === 0) continue;
          expect(contactFrames()).toContain(k % walk.frames);
          const end = 500 + facing * k * walkStride();
          expect(end).toBeGreaterThanOrEqual(0);
          expect(end).toBeLessThanOrEqual(maxX(WIDTH));
          expect(walkTime(k, turned)).toBeGreaterThanOrEqual(WALK_MIN_MS);
          expect(walkTime(k, turned)).toBeLessThanOrEqual(WALK_MAX_MS);
        }
      }
    }
    // Nowhere to go: no walk.
    expect(walkStepsFor(2000, maxX(WIDTH), 1, false, WIDTH, DISPLAY_CELL)).toBe(0);
  });
});

/** Runs the bird awake for a while on a seeded clock and reports what it did. */
function simulate(hours: number, seed: number, over: Partial<BirdState> = {}, width = 1440) {
  let r = seed;
  const rand = () => (r = (r * 16807) % 2147483647) / 2147483647;
  let s: BirdState = { ...initialState(0, width, false, false, rand()), ...over };
  const time: Partial<Record<Mode, number>> = {};
  const walks: number[] = [];
  const rests: { length: number; fidgets: Mode[] }[] = [];
  let walkStart = 0;
  let restStart = 0;
  let fidgets: Mode[] = [];
  let prev = s.mode;
  let minX = Infinity;
  let maxXs = -Infinity;
  const STEP = 50;
  for (let t = 0; t < hours * 3_600_000; t += STEP) {
    s = reduce(s, { type: "tick" }, t, rand());
    time[s.mode] = (time[s.mode] ?? 0) + STEP;
    if (s.mode === "walk" && prev !== "walk") {
      walkStart = t;
      if (t > 0) rests.push({ length: t - restStart, fidgets });
    }
    if (s.mode !== "walk" && prev === "walk") {
      walks.push(t - walkStart);
      restStart = t;
      fidgets = [];
    }
    if (s.mode !== prev && ["peck", "preen", "mutter"].includes(s.mode)) fidgets.push(s.mode);
    minX = Math.min(minX, s.x);
    maxXs = Math.max(maxXs, s.x);
    prev = s.mode;
  }
  const total = Object.values(time).reduce((a, b) => a + (b ?? 0), 0);
  return { time, total, walks, rests: rests.slice(1), minX, maxX: maxXs, end: s };
}

describe("the awake rhythm: short walks, longer rests", () => {
  const runs = [1, 7, 42].map((seed) => simulate(2, seed));

  it("walks for 1 to 4 s at a time, turn and held frames included", () => {
    for (const { walks } of runs) {
      expect(walks.length).toBeGreaterThan(400);
      // One 50 ms tick of slack either side for where the simulation samples.
      for (const w of walks) {
        expect(w).toBeGreaterThanOrEqual(WALK_MIN_MS - 50);
        expect(w).toBeLessThanOrEqual(WALK_MAX_MS + 50);
      }
    }
  });

  it("rests 6 to 20 s between walks", () => {
    for (const { rests } of runs) {
      for (const r of rests) {
        expect(r.length).toBeGreaterThanOrEqual(REST_MIN_MS - 50);
        expect(r.length).toBeLessThanOrEqual(REST_MAX_MS + 50);
      }
    }
  });

  it("walks about a quarter of its awake time", () => {
    for (const { time, total } of runs) {
      const walking = (time.walk ?? 0) / total;
      expect(walking).toBeGreaterThan(0.22);
      expect(walking).toBeLessThan(0.28);
    }
  });

  it("pecks, preens and mutters now and then while it rests, never mid-walk", () => {
    for (const { rests, time, total } of runs) {
      const all = rests.flatMap((r) => r.fidgets);
      for (const mode of ["peck", "preen", "mutter"] as const) expect(all).toContain(mode);
      // Occasional: most rests have one or two, none is busy, and fidgets are a small share of the time.
      const counts = rests.map((r) => r.fidgets.length);
      expect(Math.max(...counts)).toBeLessThanOrEqual(7);
      expect(counts.reduce((a, b) => a + b, 0) / counts.length).toBeLessThan(2.5);
      const fidgeting = ((time.peck ?? 0) + (time.preen ?? 0) + (time.mutter ?? 0)) / total;
      expect(fidgeting).toBeLessThan(0.15);
    }
  });

  it("sometimes spends a rest perched", () => {
    for (const { time, total } of runs) expect((time.perch ?? 0) / total).toBeGreaterThan(0.05);
  });

  it("gets to within one walk of both edges", () => {
    for (const { minX, maxX: right } of runs) {
      expect(minX).toBeLessThan(40);
      expect(right).toBeGreaterThan(1440 - DISPLAY_CELL.width - 40);
    }
  });

  it("draws its rest and walk lengths from the stated ranges, skewed to give the quarter", () => {
    expect([REST_MIN_MS, REST_MAX_MS, WALK_MIN_MS, WALK_MAX_MS]).toEqual([6_000, 20_000, 1_000, 4_000]);
    expect(restLength(0)).toBe(6_000);
    expect(restLength(1)).toBe(20_000);
    expect(walkLength(0)).toBe(1_000);
    expect(walkLength(1)).toBe(4_000);
    expect(restLength(0.5)).toBeLessThan(13_000);
    expect(walkLength(0.5)).toBeGreaterThan(2_500);
  });

  it("chooses its fidgets by their weights, and none starts that couldn't finish inside the rest", () => {
    expect(FIDGETS.reduce((a, [, w]) => a + w, 0)).toBeCloseTo(1);
    expect(pickFidget(0)).toBe("peck");
    expect(pickFidget(0.5)).toBe("preen");
    expect(pickFidget(0.99)).toBe("mutter");
    const late = start({ nextAt: T0, restUntil: T0 + FIDGET_LONGEST_MS - 1 });
    const waited = tick(late, T0, 0.3);
    expect(waited.mode).toBe("idle");
    expect(waited.nextAt).toBe(late.restUntil);
    expect(MUTTER_MS).toBe(FIDGET_LONGEST_MS);
  });

  it("keeps going the same way most of the time", () => {
    expect(KEEP_GOING).toBe(0.7);
    let same = 0;
    const N = 400;
    for (let i = 0; i < N; i++) {
      const w = tick(start({ x: 600, facing: 1, nextAt: T0, restUntil: T0 }), T0, (i + 0.5) / N);
      if (w.mode === "walk" && w.facing === 1) same++;
    }
    expect(same / N).toBeGreaterThan(0.6);
    expect(same / N).toBeLessThan(0.8);
  });

  it("perches about one rest in five", () => {
    let perched = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) if (enterRest(start(), T0, (i + 0.5) / N).mode === "perch") perched++;
    expect(perched / N).toBeGreaterThan(PERCH_CHANCE - 0.05);
    expect(perched / N).toBeLessThan(PERCH_CHANCE + 0.05);
    expect(mix(0.5, 1)).not.toBe(mix(0.5, 2));
  });

  it("under reduced motion never walks or fidgets", () => {
    const { time, total } = simulate(0.5, 3, { reducedMotion: true });
    expect(time.idle).toBe(total);
  });

  it("asleep stays asleep", () => {
    const { time, total } = simulate(0.5, 3, { mode: "sleep", sessionActive: true });
    expect(time.sleep).toBe(total);
  });
});
