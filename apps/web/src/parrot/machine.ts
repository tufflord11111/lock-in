/**
 * The bird's state machine. A pure reducer: no DOM, no timers, no Math.random;
 * time and randomness arrive as arguments. Coordinates are CSS px: x is the
 * cell's left edge, lift is the height of the feet above the bottom edge. The
 * cell is the bird's box in CSS px; it need not be square.
 */
import { DISPLAY_CELL, playedOnce, rowOf, type Cell, type LoopPlan } from "./animator";

export type Mode = "idle" | "walk" | "peck" | "perch" | "sleep" | "wake" | "happy" | "talk" | "drag" | "fall";

export type BirdState = {
  mode: Mode;
  enteredAt: number;
  /** When idle or perch moves on by itself. */
  nextAt: number;
  x: number;
  lift: number;
  targetX: number;
  /** x and lift at the moment the mode began, for time-based movement. */
  fromX: number;
  fromLift: number;
  facing: 1 | -1;
  /** When the bird last began turning round, and which way it faced before. Null when it never has. */
  turnStart: number | null;
  turnFrom: 1 | -1;
  /** walk: when stepping begins, after any turn; how many strides it takes; the row and frame shown while it turns. */
  stepAt: number;
  walkSteps: number;
  holdRow: string;
  holdFrame: number;
  /** The window's width in CSS px. */
  width: number;
  /** The bird's box in CSS px, from the manifest. */
  cell: Cell;
  /** Over a full-screen app: the window is hidden and nothing needs drawing. */
  hidden: boolean;
  reducedMotion: boolean;
  /** True while a session runs, whatever the mode is doing right now. */
  sessionActive: boolean;
  /** After wake: a finished session gets the happy row. */
  happyAfterWake: boolean;
};

export type BirdEvent =
  | { type: "tick" }
  | { type: "resize"; width: number }
  | { type: "session"; active: boolean }
  | { type: "stoodDown"; finished: boolean }
  | { type: "hidden"; hidden: boolean }
  | { type: "reducedMotion"; reduced: boolean }
  | { type: "talkStart" }
  | { type: "talkEnd" }
  | { type: "dragStart" }
  | { type: "dragMove"; x: number; lift: number; maxLift: number }
  | { type: "dragEnd" };

/** The art's stride: how far the sprite moves per walk frame, CSS px. */
export function walkStride(row = rowOf("walk")): number {
  if (row.stride === undefined) throw new Error("The walk row needs a stride");
  return row.stride;
}

/** Walking speed in CSS px/s: the stride times the walk row's fps. */
export const walkSpeed = (row = rowOf("walk")): number => walkStride(row) * row.fps;
export const WALK_PX_PER_S = walkSpeed();

/**
 * How far a walk has gone after this long. It moves one stride each time the
 * frame changes, on the frame's own clock, and not in between: the art has the
 * body's motion in the frames, so gliding between them would slide the planted
 * foot forward and snap it back.
 */
export function walkDistance(elapsedMs: number, row = rowOf("walk")): number {
  return Math.floor((Math.max(0, elapsedMs) * row.fps) / 1000) * walkStride(row);
}
/** The frames a walk may stop on: both feet down. From the manifest, else 0 and half way round. */
export function contactFrames(row = rowOf("walk")): number[] {
  return row.contact ?? (row.frames % 2 === 0 ? [0, row.frames / 2] : [0]);
}

/**
 * How many strides a walk of about `distance` takes: the count nearest to it
 * that ends on a contact frame and keeps the bird on the screen. 0 if none does.
 */
export function walkStepsFor(distance: number, x: number, facing: 1 | -1, width: number, cell: Cell, row = rowOf("walk")): number {
  const stride = walkStride(row);
  const contact = contactFrames(row);
  const ideal = distance / stride;
  let best = 0;
  for (let k = 1; k <= Math.ceil(ideal) + row.frames; k++) {
    if (!contact.includes(k % row.frames)) continue;
    const end = x + facing * k * stride;
    if (end < 0 || end > maxX(width, cell)) continue;
    if (best === 0 || Math.abs(k - ideal) < Math.abs(best - ideal)) best = k;
  }
  return best;
}

/** Turning round: scaleX eases to TURN_MIN_SCALE, flips, eases back, over TURN_MS, dipping TURN_DIP_PX at the middle. */
export const TURN_MS = 160;
export const TURN_MIN_SCALE = 0.08;
export const TURN_DIP_PX = 2;

/**
 * Faces the bird this way. Never at once: it turns over TURN_MS, except under
 * reduced motion, where it just flips. Every change of facing goes through here.
 */
export function faceTo(s: BirdState, facing: 1 | -1, now: number): BirdState {
  if (facing === s.facing) return s;
  if (s.reducedMotion) return { ...s, facing };
  return { ...s, facing, turnFrom: s.facing, turnStart: now };
}

export const isTurning = (s: BirdState, now: number): boolean =>
  s.turnStart !== null && now >= s.turnStart && now - s.turnStart < TURN_MS && !s.hidden && !holdsOneFrame(s);

/**
 * The drawn horizontal scale and the dip, CSS px down, at this moment of a turn:
 * the old facing squeezes to TURN_MIN_SCALE over the first half, the new one
 * opens out over the second, half-cosine eased, the dip deepest at the flip.
 * Outside a turn: the facing, no dip. x never changes.
 */
export function turnPose(s: BirdState, now: number): { scaleX: number; dip: number } {
  if (!isTurning(s, now)) return { scaleX: s.facing, dip: 0 };
  const t = now - (s.turnStart as number);
  const half = TURN_MS / 2;
  const ease = (u: number) => (1 - Math.cos(Math.PI * u)) / 2;
  const scaleX =
    t < half
      ? s.turnFrom * (1 - (1 - TURN_MIN_SCALE) * ease(t / half))
      : s.facing * (TURN_MIN_SCALE + (1 - TURN_MIN_SCALE) * ease((t - half) / half));
  return { scaleX, dip: TURN_DIP_PX * Math.sin((Math.PI * t) / TURN_MS) };
}

export const FALL_PX_PER_S = 600;
export const IDLE_MIN_MS = 4_000;
export const IDLE_MAX_MS = 20_000;
export const PERCH_MIN_MS = 30_000;
export const PERCH_MAX_MS = 120_000;

export const maxX = (width: number, cell: Cell = DISPLAY_CELL) => Math.max(0, width - cell.width);
export const restingX = (width: number, cell: Cell = DISPLAY_CELL) => Math.round(maxX(width, cell) * 0.85);

/** How often a walk heads for an edge. Uniform targets alone almost never reach one. */
export const EDGE_WALK_CHANCE = 0.3;

/** Where a walk ends: either edge some of the time, else anywhere between. */
export function walkTarget(rand: number, width: number, cell: Cell = DISPLAY_CELL): number {
  const edge = EDGE_WALK_CHANCE / 2;
  if (rand < edge) return 0;
  if (rand >= 1 - edge) return maxX(width, cell);
  return Math.round(rand * maxX(width, cell));
}

const between = (rand: number, min: number, max: number) => min + rand * (max - min);

export function initialState(
  now: number,
  width: number,
  reducedMotion: boolean,
  sessionActive: boolean,
  rand: number,
  cell: Cell = DISPLAY_CELL,
): BirdState {
  const x = restingX(width, cell);
  return {
    mode: sessionActive ? "sleep" : "idle",
    enteredAt: now,
    nextAt: now + between(rand, IDLE_MIN_MS, IDLE_MAX_MS),
    x,
    lift: 0,
    targetX: x,
    fromX: x,
    fromLift: 0,
    facing: 1,
    turnStart: null,
    turnFrom: 1,
    stepAt: now,
    walkSteps: 0,
    holdRow: "idle",
    holdFrame: 0,
    width,
    cell,
    hidden: false,
    reducedMotion,
    sessionActive,
    happyAfterWake: false,
  };
}

const enterIdle = (s: BirdState, now: number, rand: number): BirdState => ({
  ...s,
  mode: "idle",
  enteredAt: now,
  nextAt: now + between(rand, IDLE_MIN_MS, IDLE_MAX_MS),
  happyAfterWake: false,
});

/** Where anything that ended goes: asleep if a session is running, else idle. */
const settle = (s: BirdState, now: number, rand: number): BirdState =>
  s.sessionActive ? { ...s, mode: "sleep", enteredAt: now, happyAfterWake: false } : enterIdle(s, now, rand);

/**
 * Turn first if it has to, then walk: hold walk frame 0 for a frame without
 * moving, step a stride per frame, stop on a contact frame and hold it a frame,
 * then idle. While it turns it keeps the drawing it had.
 */
function startWalk(s: BirdState, now: number, rand: number): BirdState {
  const wanted = walkTarget(rand, s.width, s.cell);
  const facing: 1 | -1 = wanted > s.x ? 1 : -1;
  const steps = walkStepsFor(Math.abs(wanted - s.x), s.x, facing, s.width, s.cell);
  if (steps === 0 || steps * walkStride() < s.cell.width / 2) return enterIdle(s, now, rand);
  const holdRow = spriteState(s, now);
  const holdFrame = frameIndex(s, now, () => 0);
  const turned = faceTo(s, facing, now);
  return {
    ...turned,
    mode: "walk",
    enteredAt: now,
    stepAt: turned.turnStart === now ? now + TURN_MS : now,
    fromX: s.x,
    targetX: s.x + facing * steps * walkStride(),
    walkSteps: steps,
    holdRow,
    holdFrame,
  };
}

function tick(s: BirdState, now: number, rand: number): BirdState {
  const elapsed = now - s.enteredAt;
  switch (s.mode) {
    case "idle":
      if (s.reducedMotion || now < s.nextAt) return s;
      if (rand < 0.5) return startWalk(s, now, rand * 2);
      if (rand < 0.75) return { ...s, mode: "peck", enteredAt: now };
      return {
        ...s,
        mode: "perch",
        enteredAt: now,
        nextAt: now + between((rand - 0.75) * 4, PERCH_MIN_MS, PERCH_MAX_MS),
      };
    case "perch":
      if (s.reducedMotion || now < s.nextAt) return s;
      return startWalk(s, now, rand);
    case "walk": {
      const walked = now - s.stepAt;
      if (walked < 0) return s; // still turning: nothing moves
      const n = Math.floor((walked * rowOf("walk").fps) / 1000);
      // The last frame, a contact frame at the target, has had its frame-time.
      if (n > s.walkSteps) return enterIdle({ ...s, x: s.targetX }, now, rand);
      return { ...s, x: s.fromX + s.facing * n * walkStride() };
    }
    case "peck":
      return playedOnce(rowOf("peck"), elapsed) ? settle(s, now, rand) : s;
    case "wake":
      if (!playedOnce(rowOf("wake"), elapsed)) return s;
      return s.happyAfterWake && !s.sessionActive
        ? { ...s, mode: "happy", enteredAt: now, happyAfterWake: false }
        : settle(s, now, rand);
    case "happy":
      return playedOnce(rowOf("happy"), elapsed) ? settle(s, now, rand) : s;
    case "fall": {
      const lift = s.fromLift - (FALL_PX_PER_S * elapsed) / 1000;
      return lift <= 0 ? settle({ ...s, lift: 0 }, now, rand) : { ...s, lift };
    }
    default:
      return s;
  }
}

export function reduce(s: BirdState, event: BirdEvent, now: number, rand: number): BirdState {
  switch (event.type) {
    case "tick":
      return tick(s, now, rand);
    case "resize": {
      if (s.reducedMotion) return { ...s, width: event.width, x: restingX(event.width, s.cell) };
      const resized = { ...s, width: event.width, x: Math.min(s.x, maxX(event.width, s.cell)) };
      // A walk's end point may now be off the screen.
      return s.mode === "walk" ? enterIdle(resized, now, rand) : resized;
    }
    case "session":
      if (event.active === s.sessionActive) return s;
      if (event.active) {
        if (s.mode === "drag") return { ...s, sessionActive: true };
        return { ...s, sessionActive: true, mode: "sleep", enteredAt: now, lift: 0 };
      }
      return s.mode === "sleep"
        ? { ...s, sessionActive: false, mode: "wake", enteredAt: now }
        : { ...s, sessionActive: false };
    case "stoodDown": {
      const happyAfterWake = event.finished;
      if (s.mode === "sleep") return { ...s, sessionActive: false, mode: "wake", enteredAt: now, happyAfterWake };
      // The poll may have woken the bird a moment before this event arrived.
      if (s.mode === "wake") return { ...s, sessionActive: false, happyAfterWake };
      return { ...s, sessionActive: false };
    }
    case "hidden":
      return { ...s, hidden: event.hidden };
    case "reducedMotion":
      if (event.reduced === s.reducedMotion) return s;
      if (!event.reduced) return { ...s, reducedMotion: false, nextAt: now + between(rand, IDLE_MIN_MS, IDLE_MAX_MS) };
      return settle({ ...s, reducedMotion: true, x: restingX(s.width, s.cell), lift: 0 }, now, rand);
    case "talkStart":
      if (s.mode === "drag" || s.mode === "sleep" || s.mode === "fall") return s;
      return { ...s, mode: "talk", enteredAt: now };
    case "talkEnd":
      return s.mode === "talk" ? settle(s, now, rand) : s;
    case "dragStart":
      return { ...s, mode: "drag", enteredAt: now };
    case "dragMove":
      if (s.mode !== "drag") return s;
      return {
        ...s,
        x: Math.min(Math.max(0, event.x), maxX(s.width, s.cell)),
        lift: Math.min(Math.max(0, event.lift), Math.max(0, event.maxLift)),
      };
    case "dragEnd":
      if (s.mode !== "drag") return s;
      if (s.reducedMotion || s.lift === 0) return settle({ ...s, lift: 0 }, now, rand);
      return { ...s, mode: "fall", enteredAt: now, fromLift: s.lift };
  }
}

/**
 * The sprite row to draw. `fall` has no row in the sheet; it reuses `drag`. A
 * walk that is still turning shows the row it started from.
 */
export function spriteState(s: BirdState, now: number): string {
  if (s.mode === "fall") return "drag";
  if (s.mode === "walk" && now < s.stepAt) return s.holdRow;
  return s.mode;
}

/** A still bird changes frame at most this often, on a timer rather than rAF. */
export const STILL_STEP_MS = 1_000;

const STILL: readonly Mode[] = ["idle", "perch", "sleep"];
export const isStill = (s: BirdState): boolean => STILL.includes(s.mode);

/** Asleep it holds one frame and asks for no redraw at all: each one recomposites the whole overlay. */
export const holdsOneFrame = (s: BirdState): boolean => s.reducedMotion || s.mode === "sleep";

/**
 * Walking draws on a timer at this rate: rAF would wake the page at the
 * display's rate. The walk row's fps divides it (7.5 on 15), so every frame
 * shows for the same number of ticks.
 */
export const WALK_TICK_FPS = 15;
export const WALK_STEP_MS = 1000 / WALK_TICK_FPS;

/** What the animation loop does next. */
export function loopPlan(s: BirdState, now: number): LoopPlan {
  if (s.hidden || holdsOneFrame(s)) return { kind: "stop" };
  if (isTurning(s, now)) return { kind: "frames" };
  if (s.mode === "walk") return { kind: "wait", ms: WALK_STEP_MS };
  if (!isStill(s)) return { kind: "frames" };
  return { kind: "wait", ms: STILL_STEP_MS - ((now - s.enteredAt) % STILL_STEP_MS) };
}

/** The frame to show. Still modes step slowly from the clock; reduced motion holds frame 0. */
export function frameIndex(s: BirdState, now: number, frameAt: (state: string, elapsedMs: number) => number): number {
  if (s.mode === "walk") {
    const walked = now - s.stepAt;
    if (walked < 0) return s.holdFrame;
    const row = rowOf("walk");
    // Frame 0 is held a frame before the first stride, and the contact frame at the end a frame after the last.
    return Math.min(Math.floor((walked * row.fps) / 1000), s.walkSteps) % row.frames;
  }
  const state = spriteState(s, now);
  const elapsed = now - s.enteredAt;
  if (!isStill(s)) return frameAt(state, elapsed);
  if (holdsOneFrame(s)) return 0;
  return Math.floor(elapsed / STILL_STEP_MS) % rowOf(state).frames;
}
