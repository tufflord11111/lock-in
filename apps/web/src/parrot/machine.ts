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

/** The art's stride: 12 px per 8-frame, 10 fps cycle. Faster and the feet slide. */
export const WALK_PX_PER_S = 15;
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

function startWalk(s: BirdState, now: number, rand: number): BirdState {
  const targetX = walkTarget(rand, s.width, s.cell);
  if (Math.abs(targetX - s.x) < s.cell.width / 2) return enterIdle(s, now, rand);
  return { ...s, mode: "walk", enteredAt: now, fromX: s.x, targetX, facing: targetX > s.x ? 1 : -1 };
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
      const dist = (WALK_PX_PER_S * elapsed) / 1000;
      if (dist >= Math.abs(s.targetX - s.fromX)) return enterIdle({ ...s, x: s.targetX }, now, rand);
      return { ...s, x: s.fromX + s.facing * dist };
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

/** The sprite row to draw. `fall` has no row in the sheet; it reuses `drag`. */
export const spriteState = (s: BirdState): string => (s.mode === "fall" ? "drag" : s.mode);

/** A still bird changes frame at most this often, on a timer rather than rAF. */
export const STILL_STEP_MS = 1_000;

const STILL: readonly Mode[] = ["idle", "perch", "sleep"];
export const isStill = (s: BirdState): boolean => STILL.includes(s.mode);

/** Asleep it holds one frame and asks for no redraw at all: each one recomposites the whole overlay. */
export const holdsOneFrame = (s: BirdState): boolean => s.reducedMotion || s.mode === "sleep";

/** Walking draws on a timer at this rate: rAF would wake the page at the display's rate. */
export const WALK_STEP_MS = 1000 / 15;

/** What the animation loop does next. */
export function loopPlan(s: BirdState, now: number): LoopPlan {
  if (s.hidden || holdsOneFrame(s)) return { kind: "stop" };
  if (s.mode === "walk") return { kind: "wait", ms: WALK_STEP_MS };
  if (!isStill(s)) return { kind: "frames" };
  return { kind: "wait", ms: STILL_STEP_MS - ((now - s.enteredAt) % STILL_STEP_MS) };
}

/** The frame to show. Still modes step slowly from the clock; reduced motion holds frame 0. */
export function frameIndex(s: BirdState, now: number, frameAt: (state: string, elapsedMs: number) => number): number {
  const state = spriteState(s);
  const elapsed = now - s.enteredAt;
  if (!isStill(s)) return frameAt(state, elapsed);
  if (holdsOneFrame(s)) return 0;
  return Math.floor(elapsed / STILL_STEP_MS) % rowOf(state).frames;
}
