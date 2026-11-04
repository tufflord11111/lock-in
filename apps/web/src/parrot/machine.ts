/**
 * The bird's state machine. A pure reducer: no DOM, no timers, no Math.random;
 * time and randomness arrive as arguments. Coordinates are CSS px: x is the
 * cell's left edge, lift is the height of the feet above the bottom edge.
 */
import { DISPLAY_CELL, playedOnce, rowOf } from "./animator";

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
  width: number;
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
  | { type: "dragMove"; x: number; lift: number }
  | { type: "dragEnd" };

/** The art's stride: 12 px per 8-frame, 10 fps cycle. Faster and the feet slide. */
export const WALK_PX_PER_S = 15;
export const FALL_PX_PER_S = 600;
export const IDLE_MIN_MS = 4_000;
export const IDLE_MAX_MS = 20_000;
export const PERCH_MIN_MS = 30_000;
export const PERCH_MAX_MS = 120_000;

export const maxX = (width: number) => Math.max(0, width - DISPLAY_CELL);
export const restingX = (width: number) => Math.round(maxX(width) * 0.85);

const between = (rand: number, min: number, max: number) => min + rand * (max - min);

export function initialState(
  now: number,
  width: number,
  reducedMotion: boolean,
  sessionActive: boolean,
  rand: number,
): BirdState {
  const x = restingX(width);
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
  const targetX = Math.round(rand * maxX(s.width));
  if (Math.abs(targetX - s.x) < DISPLAY_CELL / 2) return enterIdle(s, now, rand);
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
      if (s.reducedMotion) return { ...s, width: event.width, x: restingX(event.width) };
      const resized = { ...s, width: event.width, x: Math.min(s.x, maxX(event.width)) };
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
      return settle({ ...s, reducedMotion: true, x: restingX(s.width), lift: 0 }, now, rand);
    case "talkStart":
      if (s.mode === "drag" || s.mode === "sleep" || s.mode === "fall") return s;
      return { ...s, mode: "talk", enteredAt: now };
    case "talkEnd":
      return s.mode === "talk" ? settle(s, now, rand) : s;
    case "dragStart":
      return { ...s, mode: "drag", enteredAt: now };
    case "dragMove":
      if (s.mode !== "drag") return s;
      return { ...s, x: Math.min(Math.max(0, event.x), maxX(s.width)), lift: Math.max(0, event.lift) };
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

/** The frame to show. Still modes step slowly from the clock; reduced motion holds frame 0. */
export function frameIndex(s: BirdState, now: number, frameAt: (state: string, elapsedMs: number) => number): number {
  const state = spriteState(s);
  const elapsed = now - s.enteredAt;
  if (!isStill(s)) return frameAt(state, elapsed);
  if (s.reducedMotion) return 0;
  return Math.floor(elapsed / STILL_STEP_MS) % rowOf(state).frames;
}
