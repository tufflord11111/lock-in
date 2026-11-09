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
  nextRows,
  type BirdEvent,
  type BirdState,
  ARC_PEAK_PX,
  BRANCH_FIDGET_MAX_MS,
  BRANCH_FIDGET_MIN_MS,
  BRANCH_GAP_MAX_MS,
  BRANCH_GAP_MIN_MS,
  BRANCH_STAY_MAX_MS,
  BRANCH_STAY_MIN_MS,
  FLY_PX_PER_S,
  LEAVE_MAX_MS,
  LEAVE_MIN_MS,
  arcLength,
  arcPoint,
  beginFlight,
  canFly,
  easeInOut,
  flyMs,
  nearBranch,
  perchFor,
  rowMs,
} from "./machine";
import { birdBox } from "./layout";
import {
  BRANCH,
  DROP_ON_PERCH_PX,
  FADE_NEAR_PX,
  INK,
  INTO_SCREEN,
  PERCH_HEIGHT,
  PERCH_MARGIN_PX,
  boxGap,
  branchBox,
  branchImageFor,
  cursorBoxes,
  fadeZone,
  perchSpot,
  unionBox,
} from "./perch";

const WIDTH = 1000;
const T0 = 1_000_000;
const start = (over: Partial<BirdState> = {}): BirdState => ({
  ...initialState(T0, WIDTH, false, false, 0),
  branchDueAt: Infinity,
  ...over,
});
const go = (s: BirdState, e: BirdEvent, now = T0, rand = 0.5) => reduce(s, e, now, rand);
const tick = (s: BirdState, now: number, rand = 0.5) => go(s, { type: "tick" }, now, rand);
const byRow = (state: string, elapsed: number) => frameAt(rowOf(state), elapsed);
/** A flight in progress, played to its end: where it lands and what it does there. */
const landed = (s: BirdState, rand = 0.5): BirdState => (s.mode === "flight" && s.flight ? tick(s, s.flight.endAt, rand) : s);
/** A session started from the default bird, flown up and asleep on the perch, and when it got there. */
const asleepOnPerch = (): { s: BirdState; at: number } => {
  const flying = go(start(), { type: "session", active: true });
  return { s: landed(flying), at: flying.flight!.endAt };
};

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

  it("falls asleep on the perch when a session starts, and stays put", () => {
    const { s, at } = asleepOnPerch();
    expect(s.mode).toBe("sleep");
    expect(s.onBranch).toBe(true);
    expect(tick(s, at + 86_400_000)).toBe(s);
  });

  it("wakes happy when a session ran to its end", () => {
    let { s, at } = asleepOnPerch();
    s = go(s, { type: "stoodDown", finished: true }, at);
    expect(s.mode).toBe("wake");
    s = tick(s, at + 500);
    expect(s.mode).toBe("happy");
    s = tick(s, at + 500 + 800);
    expect(s.mode).toBe("idle");
  });

  it("wakes without the celebration on any other ending", () => {
    let { s, at } = asleepOnPerch();
    s = go(s, { type: "stoodDown", finished: false }, at);
    expect(s.mode).toBe("wake");
    s = tick(s, at + 500);
    expect(s.mode).toBe("idle");
  });

  it("is still happy if the poll woke it just before the event", () => {
    let { s, at } = asleepOnPerch();
    s = go(s, { type: "session", active: false }, at);
    s = go(s, { type: "stoodDown", finished: true }, at);
    expect(tick(s, at + 500).mode).toBe("happy");
  });

  it("goes back to sleep if a new session starts while it wakes", () => {
    let { s, at } = asleepOnPerch();
    s = go(s, { type: "stoodDown", finished: true }, at);
    s = go(s, { type: "session", active: true }, at + 100);
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
    const { s, at } = asleepOnPerch();
    expect(go(s, { type: "talkStart" }, at).mode).toBe("sleep");
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
    s = go(s, { type: "dragMove", x: 300, lift: 300, maxLift: 800 });
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
  const wide = (over: Partial<BirdState> = {}): BirdState => ({ ...initialState(T0, WIDTH, false, false, 0, WIDE), branchDueAt: Infinity, ...over });

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
    const turning = faceTo(facingRight({ onBranch: true, ...perchFor(facingRight()) }), -1, T0);
    const asleep = go(turning, { type: "session", active: true }, T0 + 20);
    expect(asleep.mode).toBe("sleep");
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
  const rests: { length: number; fidgets: Mode[]; branch: boolean }[] = [];
  /** Each visit: when it landed on the branch and when it left. */
  const visits: { landed: number; left: number }[] = [];
  let onBranchSince: number | null = null;
  let branchTime = 0;
  let flightTime = 0;
  let branch = false;
  let flights = 0;
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
      if (t > 0) rests.push({ length: t - restStart, fidgets, branch });
    }
    if (s.mode !== "walk" && prev === "walk") {
      walks.push(t - walkStart);
      restStart = t;
      fidgets = [];
      branch = false;
    }
    if (s.onBranch) branch = true;
    if (s.onBranch) branchTime += STEP;
    if (s.mode === "flight") flightTime += STEP;
    if (s.onBranch && onBranchSince === null) onBranchSince = t;
    if (!s.onBranch && onBranchSince !== null) {
      visits.push({ landed: onBranchSince, left: t });
      onBranchSince = null;
    }
    if (s.mode === "flight" && prev !== "flight") flights++;
    if (s.mode !== prev && ["peck", "preen", "mutter"].includes(s.mode)) fidgets.push(s.mode);
    if (s.lift === 0 && s.mode !== "flight") {
      minX = Math.min(minX, s.x);
      maxXs = Math.max(maxXs, s.x);
    }
    prev = s.mode;
  }
  const total = Object.values(time).reduce((a, b) => a + (b ?? 0), 0);
  // On the ground: everything but the branch and the air.
  const ground = total - branchTime - flightTime;
  return { time, total, ground, walks, rests: rests.slice(1), visits, minX, maxX: maxXs, end: s, flights, hours };
}

describe("the awake rhythm: short walks, longer rests, the branch now and then", () => {
  const runs = [1, 7, 42].map((seed) => simulate(3, seed));

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

  it("rests 6 to 20 s between walks on the ground", () => {
    for (const { rests } of runs) {
      for (const r of rests.filter((r) => !r.branch)) {
        expect(r.length).toBeGreaterThanOrEqual(REST_MIN_MS - 50);
        expect(r.length).toBeLessThanOrEqual(REST_MAX_MS + 50);
      }
    }
  });

  it("flies to the branch at most 6 times an hour over 3 hours: one visit, up and back, per 10 to 15 minutes at most", () => {
    for (const { flights, visits, hours } of runs) {
      expect(visits.length / hours).toBeLessThanOrEqual(6);
      // Each visit is two flights, up and down, give or take one in the air when the run ends.
      expect(flights).toBeLessThanOrEqual(2 * visits.length + 1);
      expect(flights / hours).toBeLessThanOrEqual(12);
      // It does go: at least one visit an hour.
      expect(visits.length).toBeGreaterThanOrEqual(hours);
    }
  });

  it("stays on the branch 2 to 5 minutes each visit", () => {
    for (const { visits } of runs) {
      for (const v of visits) {
        expect(v.left - v.landed).toBeGreaterThanOrEqual(BRANCH_STAY_MIN_MS - 50);
        expect(v.left - v.landed).toBeLessThanOrEqual(BRANCH_STAY_MAX_MS + 50);
      }
    }
  });

  it("leaves 10 to 15 minutes between leaving the branch and the next visit, plus the walk it finishes first", () => {
    for (const { visits } of runs) {
      for (let i = 1; i < visits.length; i++) {
        const gap = visits[i].landed - visits[i - 1].left;
        expect(gap).toBeGreaterThanOrEqual(BRANCH_GAP_MIN_MS);
        // The gap, then the walk and the rest it is in the middle of, then the flight up.
        expect(gap).toBeLessThanOrEqual(BRANCH_GAP_MAX_MS + REST_MAX_MS + WALK_MAX_MS + 10_000);
      }
    }
  });

  it("on the branch only preens: no pecks, mutters or walks up there", () => {
    let r = 11;
    const rand = () => (r = (r * 16807) % 2147483647) / 2147483647;
    let s = landed(beginFlight(start(), 0, perchFor(start()), true));
    const seen = new Set<Mode>();
    for (let t = s.enteredAt; t < s.enteredAt + 600_000 && s.onBranch; t += 50) {
      s = tick(s, t, rand());
      if (s.onBranch) seen.add(s.mode);
    }
    expect([...seen].sort()).toEqual(["idle", "preen"].filter((m) => seen.has(m as Mode)).sort());
    expect(seen.has("idle")).toBe(true);
  });

  it("walks about a quarter of its time on the ground", () => {
    for (const { time, ground } of runs) {
      const walking = (time.walk ?? 0) / ground;
      expect(walking).toBeGreaterThan(0.22);
      expect(walking).toBeLessThan(0.28);
    }
  });

  it("pecks, preens and mutters now and then while it rests on the ground, never mid-walk", () => {
    for (const { rests, time, total } of runs) {
      const ground = rests.filter((r) => !r.branch);
      const all = ground.flatMap((r) => r.fidgets);
      for (const mode of ["peck", "preen", "mutter"] as const) expect(all).toContain(mode);
      // Occasional: most rests have one or two, none is busy, and fidgets are a small share of the time.
      const counts = ground.map((r) => r.fidgets.length);
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

  it("under reduced motion never walks, fidgets or flies", () => {
    const { time, total, flights } = simulate(0.5, 3, { reducedMotion: true });
    expect(time.idle).toBe(total);
    expect(flights).toBe(0);
  });

  it("asleep stays asleep, and never flies", () => {
    const { time, total, flights } = simulate(0.5, 3, { mode: "sleep", sessionActive: true });
    expect(time.sleep).toBe(total);
    expect(flights).toBe(0);
  });
});

describe("the branch and the perch", () => {
  const H = 900;

  it("is flush with the right edge, its perch point 55% of the way down", () => {
    const box = branchBox(1440, H);
    expect(box.x + box.w).toBe(1440);
    expect(box.y + BRANCH.perchY).toBeCloseTo(H * PERCH_HEIGHT, 0);
    expect(PERCH_HEIGHT).toBe(0.55);
  });

  it("stands the bird's feet on the branch at the perch's height, as near the perch point as the screen allows", () => {
    const spot = perchSpot(1440, H, DISPLAY_CELL);
    const box = birdBox({ ...spot, cell: DISPLAY_CELL }, H);
    const branch = branchBox(1440, H);
    const feetX = box.x + DISPLAY_CELL.width / 2;
    expect(box.y + (DISPLAY_CELL.baseline ?? DISPLAY_CELL.height)).toBeCloseTo(branch.y + BRANCH.perchY, 0);
    expect(feetX).toBeGreaterThan(branch.x);
    expect(feetX).toBeLessThanOrEqual(branch.x + BRANCH.perchX);
    // With the art's perch point the bird would overhang the edge, so it moved in, no further than needed.
    const reach = Math.max(DISPLAY_CELL.width - INK.left, INK.right);
    expect(spot.x).toBe(Math.min(Math.round(branch.x + BRANCH.perchX - DISPLAY_CELL.width / 2), Math.floor(1440 - PERCH_MARGIN_PX - reach)));
  });

  it("keeps the whole perched bird, beak and tail, inside the work area, facing in or arriving facing the edge", () => {
    for (const width of [800, 1280, 1440, 1920, 2560]) {
      for (const height of [600, 900, 1032, 1400]) {
        const spot = perchSpot(width, height, DISPLAY_CELL);
        // Facing in, the cell is mirrored about its centre: the ink's left edge becomes its right.
        expect(spot.x + DISPLAY_CELL.width - INK.left).toBeLessThanOrEqual(width);
        expect(spot.x + INK.right).toBeLessThanOrEqual(width);
        expect(spot.x + INK.left).toBeGreaterThanOrEqual(0);
        const box = birdBox({ ...spot, cell: DISPLAY_CELL }, height);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.h).toBeLessThanOrEqual(height);
      }
    }
    expect(INK.left).toBeGreaterThanOrEqual(0);
    expect(INK.right).toBeLessThanOrEqual(DISPLAY_CELL.width);
  });

  it("measures the gap between boxes, and the box around both", () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    expect(boxGap(a, { x: 5, y: 5, w: 10, h: 10 })).toBe(0);
    expect(boxGap(a, { x: 13, y: 0, w: 10, h: 10 })).toBe(3);
    expect(boxGap(a, { x: 13, y: 14, w: 10, h: 10 })).toBe(5);
    expect(unionBox(a, { x: 20, y: 5, w: 10, h: 10 }, 2)).toEqual({ x: -2, y: -2, w: 34, h: 19 });
  });
});

describe("flight", () => {
  const ground = (over: Partial<BirdState> = {}) => start({ x: 300, facing: 1, ...over });

  it("takes off, flies the arc and lands, each row in its own time", () => {
    const s = ground();
    const to = perchFor(s);
    const f = beginFlight(s, T0, to, true);
    const fl = f.flight!;
    expect(f.mode).toBe("flight");
    expect(fl.takeoffAt).toBe(T0);
    expect(fl.flyAt).toBe(T0 + rowMs("takeoff"));
    expect(fl.landAt - fl.flyAt).toBeCloseTo(flyMs({ x: 300, lift: 0 }, to), 6);
    // Flying right, it turns in the air at the perch before the land row.
    expect(fl.landRowAt).toBe(fl.landAt + TURN_MS);
    expect(fl.endAt).toBe(fl.landRowAt + rowMs("land"));
    expect(spriteState(f, T0 + 1)).toBe("takeoff");
    expect(spriteState(f, fl.flyAt + 1)).toBe("fly");
    expect(spriteState(f, fl.landAt + 1)).toBe("fly");
    expect(spriteState(f, fl.landRowAt + 1)).toBe("land");
    expect(frameIndex(f, fl.flyAt + 1, byRow)).toBe(0);
    // Takes off in place, lands in place.
    expect(tick(f, fl.flyAt - 1).x).toBe(300);
    expect(tick(f, fl.landAt + 1)).toMatchObject(to);
    const done = tick(f, fl.endAt);
    expect(done.onBranch).toBe(true);
    expect(done.flight).toBeNull();
    expect(done).toMatchObject(to);
  });

  it("flies at about 350 px/s along the arc, easing in and out, 80 px above the straight line at the middle", () => {
    const from = { x: 200, lift: 0 };
    const to = { x: 1300, lift: 400 };
    expect(FLY_PX_PER_S).toBe(350);
    expect(ARC_PEAK_PX).toBe(80);
    expect((arcLength(from, to) / flyMs(from, to)) * 1000).toBeCloseTo(350, 6);
    const mid = arcPoint(from, to, 0.5);
    expect(mid.lift - (from.lift + to.lift) / 2).toBeCloseTo(80, 6);
    expect(arcPoint(from, to, 0)).toEqual(from);
    expect(arcPoint(from, to, 1).x).toBeCloseTo(to.x, 6);
    expect(arcPoint(from, to, 1).lift).toBeCloseTo(to.lift, 6);
    // Eased: slow at the ends, quick in the middle.
    expect(easeInOut(0.1)).toBeLessThan(0.1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 6);
    expect(easeInOut(0.9)).toBeGreaterThan(0.9);
  });

  it("moves smoothly: no jump bigger than a 30 Hz frame at its top speed", () => {
    let s = beginFlight(ground(), T0, perchFor(ground()), true);
    const fl = s.flight!;
    let prev = { x: s.x, lift: s.lift };
    for (let t = fl.flyAt; t <= fl.landAt; t += 1000 / 30) {
      s = tick(s, t);
      const step = Math.hypot(s.x - prev.x, s.lift - prev.lift);
      // An eased arc peaks at pi/2 times its average speed.
      // An eased arc peaks at about pi/2 times its average speed; the rise adds a little.
      expect(step).toBeLessThan(((FLY_PX_PER_S * Math.PI) / 2 / 30) * 1.25);
      prev = { x: s.x, lift: s.lift };
    }
  });

  it("faces the way it goes, turning round first when it must", () => {
    const away = ground({ facing: -1 });
    const f = beginFlight(away, T0, perchFor(away), true);
    expect(f.facing).toBe(1);
    expect(f.turnStart).toBe(T0);
    expect(f.flight!.takeoffAt).toBe(T0 + TURN_MS);
    expect(spriteState(f, T0 + 10)).toBe("idle");
    const down = beginFlight({ ...away, onBranch: true, facing: 1, ...perchFor(away) }, T0, { x: 100, lift: 0 }, false);
    expect(down.facing).toBe(-1);
  });

  it("costs frames only while flying; asleep on the perch it asks for none", () => {
    const f = beginFlight(ground(), T0, perchFor(ground()), true);
    expect(loopPlan(f, T0 + 100).kind).toBe("frames");
    const { s, at } = asleepOnPerch();
    expect(loopPlan(s, at).kind).toBe("stop");
  });
});

describe("when it flies", () => {
  it("flies up once when a session starts, lands and sleeps there, and does nothing more", () => {
    const flying = go(start(), { type: "session", active: true });
    expect(flying.mode).toBe("flight");
    expect(flying.flight!.toBranch).toBe(true);
    let s = flying;
    let flights = 1;
    let prev = s.mode;
    for (let t = T0; t < T0 + 3_600_000; t += 50) {
      s = tick(s, t, (t % 997) / 997);
      if (s.mode === "flight" && prev !== "flight") flights++;
      prev = s.mode;
    }
    expect(flights).toBe(1);
    expect(s.mode).toBe("sleep");
    expect(s.onBranch).toBe(true);
    expect(s).toMatchObject(perchFor(s));
  });

  it("wakes on the perch when the session ends, then flies down after 2 to 5 s", () => {
    let { s, at } = asleepOnPerch();
    s = go(s, { type: "stoodDown", finished: false }, at);
    s = tick(s, at + rowMs("wake"));
    expect(s.mode).toBe("idle");
    expect(s.onBranch).toBe(true);
    const awake = at + rowMs("wake");
    expect(s.restUntil - awake).toBeGreaterThanOrEqual(LEAVE_MIN_MS);
    expect(s.restUntil - awake).toBeLessThanOrEqual(LEAVE_MAX_MS);
    // Nothing else is due before then.
    for (let t = awake; t < s.restUntil; t += 50) expect(tick(s, t).mode).not.toBe("flight");
    const down = tick({ ...s, nextAt: s.restUntil }, s.restUntil);
    expect(down.mode).toBe("flight");
    expect(down.flight!.toBranch).toBe(false);
    expect(down.flight!.to.lift).toBe(0);
    expect(down.flight!.to.x).toBeGreaterThanOrEqual(0);
    expect(down.flight!.to.x).toBeLessThanOrEqual(maxX(WIDTH));
    // Back on the ground the rest is over: it walks, or rests again if it has no room.
    expect(["walk", "idle", "perch", "flight"]).toContain(landed(down).mode);
    expect(landed(down).onBranch).toBe(false);
  });

  it("the session's flight up, already on its way, isn't made twice", () => {
    const flying = go(start(), { type: "session", active: true });
    const again = go(go(flying, { type: "session", active: false }, T0 + 100), { type: "session", active: true }, T0 + 200);
    expect(again.flight).toEqual(flying.flight);
  });

  it("on a visit it stays 2 to 5 minutes, preening only every 8 to 20 s, then flies down", () => {
    expect([BRANCH_STAY_MIN_MS, BRANCH_STAY_MAX_MS]).toEqual([120_000, 300_000]);
    expect([BRANCH_FIDGET_MIN_MS, BRANCH_FIDGET_MAX_MS]).toEqual([8_000, 20_000]);
    for (const rand of [0.01, 0.3, 0.6, 0.99]) {
      const up = beginFlight(start(), T0, perchFor(start()), true);
      const sitting = landed(up, rand);
      expect(sitting.mode).toBe("idle");
      expect(sitting.onBranch).toBe(true);
      const stay = sitting.restUntil - up.flight!.endAt;
      expect(stay).toBeGreaterThanOrEqual(BRANCH_STAY_MIN_MS);
      expect(stay).toBeLessThanOrEqual(BRANCH_STAY_MAX_MS);
      const firstPreen = sitting.nextAt - up.flight!.endAt;
      expect(firstPreen).toBeGreaterThanOrEqual(BRANCH_FIDGET_MIN_MS);
      expect(firstPreen).toBeLessThanOrEqual(BRANCH_FIDGET_MAX_MS);
    }
  });

  it("a bubble on the branch doesn't make the visit longer", () => {
    const sitting = landed(beginFlight(start(), T0, perchFor(start()), true));
    const talked = go(go(sitting, { type: "talkStart" }, T0 + 30_000), { type: "talkEnd" }, T0 + 33_000, 0.9);
    expect(talked.onBranch).toBe(true);
    expect(talked.restUntil).toBe(sitting.restUntil);
  });

  it("goes up at the end of the first walk once a visit is due, and not before", () => {
    const walking = (dueAt: number) => beginWalk(start({ x: 300, branchDueAt: dueAt }), T0, 1, 2000)!;
    for (const rand of [0.05, 0.5, 0.95]) {
      expect(tick(walking(T0 + 3_600_000), T0 + 60_000, rand).mode).not.toBe("flight");
      const up = tick(walking(T0), T0 + 60_000, rand);
      expect(up.mode).toBe("flight");
      expect(up.flight!.toBranch).toBe(true);
    }
  });

  it("schedules the next visit 10 to 15 minutes after it leaves the branch, and from the start", () => {
    expect([BRANCH_GAP_MIN_MS, BRANCH_GAP_MAX_MS]).toEqual([600_000, 900_000]);
    const boot = initialState(T0, WIDTH, false, false, 0.4);
    expect(boot.branchDueAt - T0).toBeGreaterThanOrEqual(BRANCH_GAP_MIN_MS);
    expect(boot.branchDueAt - T0).toBeLessThanOrEqual(BRANCH_GAP_MAX_MS);
    const sitting = landed(beginFlight(start(), T0, perchFor(start()), true));
    const down = tick({ ...sitting, nextAt: sitting.restUntil }, sitting.restUntil);
    expect(down.mode).toBe("flight");
    expect(down.branchDueAt - sitting.restUntil).toBeGreaterThanOrEqual(BRANCH_GAP_MIN_MS);
    expect(down.branchDueAt - sitting.restUntil).toBeLessThanOrEqual(BRANCH_GAP_MAX_MS);
    // Picked up off the branch counts as leaving it too.
    const lifted = go(sitting, { type: "dragStart" }, T0 + 50_000);
    expect(lifted.branchDueAt - (T0 + 50_000)).toBeGreaterThanOrEqual(BRANCH_GAP_MIN_MS);
  });

  describe("never", () => {
    // A visit is due, so a walk's end would fly up if it could.
    const walkDone = (over: Partial<BirdState>) => tick(beginWalk(start({ x: 300, branchDueAt: T0, ...over }), T0, 1, 2000)!, T0 + 60_000, 0.5);

    it("checks: only with motion, shown, and nothing open", () => {
      expect(canFly(start())).toBe(true);
      expect(canFly(start({ reducedMotion: true }))).toBe(false);
      expect(canFly(start({ hidden: true }))).toBe(false);
      expect(canFly(start({ talking: true }))).toBe(false);
    });

    it("from a walk with a bubble or the menu open, or hidden", () => {
      expect(walkDone({}).mode).toBe("flight");
      expect(walkDone({ talking: true }).mode).not.toBe("flight");
      expect(walkDone({ hidden: true }).mode).not.toBe("flight");
    });

    it("during a session, beyond the flight up", () => {
      // Dropped on the ground in a session: it sleeps there, with no flight up.
      let s = go(start(), { type: "session", active: true });
      s = go(landed(s), { type: "dragStart" });
      s = go(s, { type: "dragMove", x: 200, lift: 0, maxLift: 800 });
      s = go(s, { type: "dragEnd" });
      expect(s.mode).toBe("sleep");
      for (let t = T0; t < T0 + 600_000; t += 500) expect(tick(s, t).mode).toBe("sleep");
    });

    it("with a bubble open when the session starts: straight to the perch, asleep", () => {
      const talking = go(start(), { type: "talkStart" });
      const s = go(talking, { type: "session", active: true });
      expect(s.mode).toBe("sleep");
      expect(s.onBranch).toBe(true);
      expect(s).toMatchObject(perchFor(s));
    });

    it("off the branch while a bubble is open: it waits", () => {
      const sitting = { ...landed(beginFlight(start(), T0, perchFor(start()), true)), talking: true };
      const due = { ...sitting, nextAt: sitting.restUntil };
      const waited = tick(due, sitting.restUntil);
      expect(waited.mode).toBe("idle");
      expect(waited.onBranch).toBe(true);
      expect(waited.nextAt).toBeGreaterThan(sitting.restUntil);
    });

    it("over a full-screen app: the session puts it straight on the perch", () => {
      const s = go(start({ hidden: true }), { type: "session", active: true });
      expect(s.mode).toBe("sleep");
      expect(s.onBranch).toBe(true);
    });

    it("under reduced motion: straight up to the perch and, after, straight down", () => {
      let s = go(start({ reducedMotion: true }), { type: "session", active: true });
      expect(s.mode).toBe("sleep");
      expect(s.onBranch).toBe(true);
      s = go(s, { type: "stoodDown", finished: false }, T0 + 1000);
      s = tick(s, T0 + 1000 + rowMs("wake"));
      expect(s.mode).toBe("idle");
      expect(s.onBranch).toBe(true);
      // Still, but the loop wakes once for the jump down.
      expect(loopPlan(s, T0 + 2000)).toEqual({ kind: "wait", ms: s.restUntil - (T0 + 2000) });
      const down = tick(s, s.restUntil);
      expect(down.mode).toBe("idle");
      expect(down.onBranch).toBe(false);
      expect(down).toMatchObject({ x: restingX(WIDTH), lift: 0 });
    });

    it("reduced motion turned on mid-flight: it is where it was going at once", () => {
      const f = go(start(), { type: "session", active: true });
      const s = go(f, { type: "reducedMotion", reduced: true }, T0 + 500);
      expect(s.mode).toBe("sleep");
      expect(s.onBranch).toBe(true);
      expect(s.flight).toBeNull();
    });
  });
});

describe("dragged off the perch and dropped", () => {
  const perched = () => landed(beginFlight(start(), T0, perchFor(start()), true));
  const dropAt = (s: BirdState, x: number, lift: number) => {
    let d = go(s, { type: "dragStart" });
    d = go(d, { type: "dragMove", x, lift, maxLift: 800 });
    return d;
  };

  it("comes off the perch when picked up, without a jump where it overhangs the edge", () => {
    const p = perched();
    const d = go(p, { type: "dragStart" });
    expect(d.onBranch).toBe(false);
    expect(d.mode).toBe("drag");
    const held = go(d, { type: "dragMove", x: p.x, lift: p.lift, maxLift: 800 });
    expect(held.x).toBe(p.x);
    expect(go(d, { type: "dragMove", x: p.x + 500, lift: p.lift, maxLift: 800 }).x).toBe(Math.max(p.x, maxX(p.width)));
  });

  it("dropped within 60 px of the branch, lands on the perch", () => {
    expect(DROP_ON_PERCH_PX).toBe(60);
    const s = perched();
    const branch = branchBox(s.width, s.height);
    // The bird's box 55 px left of the branch, level with it.
    const x = branch.x - 55 - DISPLAY_CELL.width;
    const lift = s.height - branch.y - DISPLAY_CELL.height;
    const d = dropAt(s, x, lift);
    expect(nearBranch(d)).toBe(true);
    const dropped = go(d, { type: "dragEnd" }, T0 + 1000);
    expect(dropped.mode).toBe("flight");
    expect(spriteState(dropped, T0 + 1001)).toBe("land");
    expect(dropped).toMatchObject(perchFor(s));
    const rested = tick(dropped, T0 + 1000 + rowMs("land"));
    expect(rested.onBranch).toBe(true);
    expect(rested.mode).toBe("idle");
  });

  it("dropped further away, falls to the bottom as before", () => {
    const s = perched();
    const branch = branchBox(s.width, s.height);
    const x = branch.x - 65 - DISPLAY_CELL.width;
    const lift = s.height - branch.y - DISPLAY_CELL.height;
    const d = dropAt(s, x, lift);
    expect(boxGap(birdBox(d, d.height), branch)).toBeGreaterThan(60);
    const dropped = go(d, { type: "dragEnd" }, T0 + 1000);
    expect(dropped.mode).toBe("fall");
    expect(dropped.onBranch).toBe(false);
  });

  it("in a session, dropped on the perch it sleeps there", () => {
    const { s, at } = asleepOnPerch();
    const branch = branchBox(s.width, s.height);
    const d = dropAt(s, branch.x - 20 - DISPLAY_CELL.width, s.height - branch.y - DISPLAY_CELL.height);
    const dropped = go(d, { type: "dragEnd" }, at + 1000);
    expect(tick(dropped, at + 1000 + rowMs("land")).mode).toBe("sleep");
  });

  it("under reduced motion, dropped by the branch it is on the perch at once", () => {
    const s = { ...perched(), reducedMotion: true };
    const branch = branchBox(s.width, s.height);
    const d = dropAt(s, branch.x - 20 - DISPLAY_CELL.width, s.height - branch.y - DISPLAY_CELL.height);
    const dropped = go(d, { type: "dragEnd" }, T0 + 1000);
    expect(dropped.mode).toBe("idle");
    expect(dropped.onBranch).toBe(true);
  });

  it("stays on the perch when the window changes size", () => {
    const s = go(perched(), { type: "resize", width: 1600, height: 1000 });
    expect(s.onBranch).toBe(true);
    expect(s).toMatchObject(perchSpot(1600, 1000, DISPLAY_CELL));
  });
});

describe("what the overlay tells Rust", () => {
  const perched = () => landed(beginFlight(start(), T0, perchFor(start()), true));

  it("sends a fade zone only while perched: the bird and the branch, 120 px around", () => {
    const s = perched();
    const zone = fadeZone(s, s.width, s.height)!;
    expect(FADE_NEAR_PX).toBe(120);
    expect(zone).toEqual(unionBox(birdBox(s, s.height), branchBox(s.width, s.height), 120));
    expect(fadeZone(start(), WIDTH, start().height)).toBeNull();
    expect(fadeZone(go(s, { type: "dragStart" }), s.width, s.height)).toBeNull();
    expect(fadeZone(beginFlight(s, T0, { x: 100, lift: 0 }, false), s.width, s.height)).toBeNull();
  });

  it("never offers the branch to the cursor, and the bird only when it isn't in the air", () => {
    const s = perched();
    const card = { x: 1, y: 2, w: 3, h: 4 };
    expect(cursorBoxes(s, s.height, [card])).toEqual([birdBox(s, s.height), card]);
    expect(cursorBoxes(beginFlight(s, T0, { x: 100, lift: 0 }, false), s.height, [card])).toEqual([card]);
    const branch = branchBox(s.width, s.height);
    expect(cursorBoxes(s, s.height, [])).not.toContainEqual(branch);
  });

  it("draws the branch from the drawing that matches the display", () => {
    const images = [1, 1.5, 2].map((scale) => ({ scale, file: `b${scale}`, width: 10 * scale, height: 5 * scale }));
    expect(branchImageFor(1, images)?.scale).toBe(1);
    expect(branchImageFor(1.25, images)?.scale).toBe(1);
    expect(branchImageFor(1.5, images)?.scale).toBe(1.5);
    expect(branchImageFor(2, images)?.scale).toBe(2);
    expect(branchImageFor(3, images)?.scale).toBe(2);
    expect(branchImageFor(1, [])).toBeNull();
    expect(BRANCH.width).toBeGreaterThan(0);
  });
});

describe("a turn never makes the bird vanish", () => {
  it("is never thinner than a third of the bird, at any moment of any turn", () => {
    expect(TURN_MIN_SCALE).toBeGreaterThanOrEqual(0.35);
    const turning = faceTo(start({ facing: 1 }), -1, T0);
    for (let t = 0; t <= TURN_MS; t += 0.5) expect(Math.abs(turnPose(turning, T0 + t).scaleX)).toBeGreaterThanOrEqual(TURN_MIN_SCALE - 1e-9);
  });

  it("keeps the frame check's squeeze alarm quiet", async () => {
    const { SQUEEZE_BELOW } = await import("./frameCheck");
    expect(TURN_MIN_SCALE).toBeGreaterThan(SQUEEZE_BELOW);
  });
});

describe("the rows decoded ahead", () => {
  it("lists the row it is drawing first", () => {
    const s = start();
    expect(nextRows(s, T0)[0]).toBe(spriteState(s, T0));
    const f = beginFlight(start(), T0, perchFor(start()), true);
    expect(nextRows(f, T0 + 1)[0]).toBe("takeoff");
  });

  it("already holds every row the bird changes to, through hours of everything it does", () => {
    let r = 9;
    const rand = () => (r = (r * 16807) % 2147483647) / 2147483647;
    let s = start({ height: 900, branchDueAt: T0 });
    let changes = 0;
    let dropAt = Infinity;
    const misses = new Map<string, number>();
    for (let t = T0; t < T0 + 3 * 3_600_000; t += 50) {
      const roll = rand();
      let e: BirdEvent = { type: "tick" };
      if (t >= dropAt) {
        e = { type: "dragEnd" };
        dropAt = Infinity;
      } else if (roll < 0.0004) e = { type: "talkStart" };
      else if (roll < 0.0008) e = { type: "talkEnd" };
      else if (roll < 0.0009) e = { type: "session", active: !s.sessionActive };
      else if (roll < 0.00095 && s.mode !== "drag") {
        e = { type: "dragStart" };
        dropAt = t + 1000;
      }
      const ahead = nextRows(s, t);
      const before = spriteState(s, t);
      s = reduce(s, e, t, rand());
      // The next draw, at the next tick.
      const after = spriteState(s, t + 50);
      if (after !== before) {
        changes++;
        if (!ahead.includes(after)) misses.set(`${before}->${after}`, (misses.get(`${before}->${after}`) ?? 0) + 1);
      }
    }
    expect(changes).toBeGreaterThan(500);
    expect([...misses]).toEqual([]);
  });
});

describe("on the perch it faces into the screen", () => {
  const into = INTO_SCREEN;

  it("lands facing in: it turns in the air at the perch first, then the land row", () => {
    const f = beginFlight(start({ x: 300, facing: 1 }), T0, perchFor(start()), true);
    const fl = f.flight!;
    expect(f.facing).toBe(1);
    const turning = tick(f, fl.landAt + 10);
    expect(turning.facing).toBe(into);
    expect(turning.turnStart).toBe(fl.landAt);
    expect(isTurning(turning, fl.landAt + 10)).toBe(true);
    // The turn is over before the land row starts, and the land row is drawn facing in.
    const landing = tick(turning, fl.landRowAt + 1);
    expect(spriteState(landing, fl.landRowAt + 1)).toBe("land");
    expect(isTurning(landing, fl.landRowAt + 1)).toBe(false);
    expect(turnPose(landing, fl.landRowAt + 1).scaleX).toBe(into);
    expect(tick(landing, fl.endAt).facing).toBe(into);
  });

  it("takes off from the perch facing in, without a turn", () => {
    const perched = landed(beginFlight(start(), T0, perchFor(start()), true));
    const down = beginFlight(perched, perched.restUntil, { x: 200, lift: 0 }, false);
    expect(down.facing).toBe(into);
    expect(down.flight!.takeoffAt).toBe(perched.restUntil);
  });

  it("put on the perch, dropped on it or booted asleep on it, it faces in", () => {
    expect(initialState(T0, WIDTH, false, true, 0).facing).toBe(into);
    expect(go(start({ facing: 1, talking: true }), { type: "session", active: true }).facing).toBe(into);
    expect(go(start({ facing: 1, reducedMotion: true }), { type: "session", active: true }).facing).toBe(into);
    let d = go(start({ facing: 1 }), { type: "dragStart" });
    const branch = branchBox(d.width, d.height);
    d = go(d, { type: "dragMove", x: branch.x - 20 - DISPLAY_CELL.width, lift: d.height - branch.y - DISPLAY_CELL.height, maxLift: 800 });
    const dropped = go(d, { type: "dragEnd" }, T0 + 1000);
    expect(dropped.facing).toBe(into);
    expect(tick(dropped, T0 + 1000 + rowMs("land")).facing).toBe(into);
  });

  it("never faces the edge on the perch, through hours of rests, fidgets, talk, sessions and blinks", () => {
    let r = 5;
    const rand = () => (r = (r * 16807) % 2147483647) / 2147483647;
    let s = start({ height: 900, branchDueAt: T0 });
    let perchedTicks = 0;
    for (let t = T0; t < T0 + 4 * 3_600_000; t += 50) {
      const roll = rand();
      // Now and then a bubble, a session, or the end of one.
      let e: BirdEvent = { type: "tick" };
      if (roll < 0.0004) e = { type: "talkStart" };
      else if (roll < 0.0008) e = { type: "talkEnd" };
      else if (roll < 0.0009) e = { type: "session", active: !s.sessionActive };
      s = reduce(s, e, t, rand());
      if (s.onBranch) {
        perchedTicks++;
        expect(s.facing).toBe(into);
        expect(turnPose(s, t).scaleX).toBeLessThan(0);
      }
      const f = s.flight;
      if (s.mode === "flight" && f) {
        // Landing on the perch, from the land row on, and taking off from it: facing in.
        if (f.toBranch && t >= f.landRowAt) expect(turnPose(s, t).scaleX).toBe(into);
        if (!f.toBranch && f.from.x === perchFor(s).x && f.from.lift === perchFor(s).lift) expect(s.facing).toBe(into);
      }
    }
    expect(perchedTicks).toBeGreaterThan(10_000);
  });

  it("a mistake that left it facing the edge on the perch is put right", () => {
    const perched = landed(beginFlight(start(), T0, perchFor(start()), true));
    const wrong = { ...perched, facing: 1 as const };
    expect(tick(wrong, perched.nextAt).facing).toBe(into);
  });
});
