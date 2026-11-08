/**
 * The bird's state machine. A pure reducer: no DOM, no timers, no Math.random;
 * time and randomness arrive as arguments. Coordinates are CSS px: x is the
 * cell's left edge, lift is the height of the feet above the bottom edge. The
 * cell is the bird's box in CSS px; it need not be square.
 */
import { DISPLAY_CELL, playedOnce, rowOf, type Cell, type LoopPlan } from "./animator";

export type Mode =
  | "idle"
  | "walk"
  | "peck"
  | "preen"
  | "mutter"
  | "perch"
  | "sleep"
  | "wake"
  | "happy"
  | "talk"
  | "drag"
  | "fall";

export type BirdState = {
  mode: Mode;
  enteredAt: number;
  /** When idle or perch next decides something: a fidget, or the walk that ends the rest. */
  nextAt: number;
  /** When the current rest between walks is over. */
  restUntil: number;
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

/** How long a walk of k strides takes: the turn if any, frame 0 held, k strides, the last frame held. */
export const walkTime = (steps: number, turned: boolean, row = rowOf("walk")): number =>
  (turned ? TURN_MS : 0) + ((steps + 1) * 1000) / row.fps;

/**
 * How many strides a walk of about `durationMs` takes: the count whose walk
 * time is nearest it, within WALK_MIN_MS to WALK_MAX_MS, that ends on a
 * contact frame and keeps the bird on the screen. 0 if none does.
 */
export function walkStepsFor(
  durationMs: number,
  x: number,
  facing: 1 | -1,
  turned: boolean,
  width: number,
  cell: Cell,
  row = rowOf("walk"),
): number {
  const stride = walkStride(row);
  const contact = contactFrames(row);
  let best = 0;
  for (let k = 1; walkTime(k, turned, row) <= WALK_MAX_MS; k++) {
    if (!contact.includes(k % row.frames) || walkTime(k, turned, row) < WALK_MIN_MS) continue;
    const end = x + facing * k * stride;
    if (end < 0 || end > maxX(width, cell)) continue;
    if (best === 0 || Math.abs(walkTime(k, turned, row) - durationMs) < Math.abs(walkTime(best, turned, row) - durationMs)) best = k;
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

/*
 * The awake rhythm: a walk of WALK_MIN_MS to WALK_MAX_MS, then a rest of
 * REST_MIN_MS to REST_MAX_MS, and again. A rest is idle, or now and then
 * perched; idle fidgets every FIDGET_MIN_MS to FIDGET_MAX_MS with a peck, a
 * preen or a mutter (the blink has its own clock). Rest lengths lean short
 * (REST_SKEW) and walk lengths long (WALK_SKEW) so that walking is about a
 * quarter of the awake time.
 */
export const WALK_MIN_MS = 1_000;
export const WALK_MAX_MS = 4_000;
export const WALK_SKEW = 0.5;
export const REST_MIN_MS = 6_000;
export const REST_MAX_MS = 20_000;
export const REST_SKEW = 4;
export const PERCH_CHANCE = 0.2;
export const FIDGET_MIN_MS = 2_500;
export const FIDGET_MAX_MS = 6_000;
export const MUTTER_MS = 1_500;
/** The longest fidget: none starts this close to the end of a rest. */
export const FIDGET_LONGEST_MS = MUTTER_MS;
/** The next walk keeps going the way the bird faces this often, so it gets from one side to the other. */
export const KEEP_GOING = 0.7;
export const FIDGETS: readonly (readonly [Mode, number])[] = [
  ["peck", 0.4],
  ["preen", 0.35],
  ["mutter", 0.25],
];

export const maxX = (width: number, cell: Cell = DISPLAY_CELL) => Math.max(0, width - cell.width);
export const restingX = (width: number, cell: Cell = DISPLAY_CELL) => Math.round(maxX(width, cell) * 0.85);

const between = (rand: number, min: number, max: number) => min + rand * (max - min);

/** One random number in, several independent-looking ones out, so the reducer still takes a single rand. */
export function mix(rand: number, salt: number): number {
  const v = Math.sin(rand * 12.9898 + salt * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

export const walkLength = (u: number) => between(u ** WALK_SKEW, WALK_MIN_MS, WALK_MAX_MS);
export const restLength = (u: number) => between(u ** REST_SKEW, REST_MIN_MS, REST_MAX_MS);
export const fidgetGap = (u: number) => between(u, FIDGET_MIN_MS, FIDGET_MAX_MS);

export function pickFidget(u: number): Mode {
  let acc = 0;
  for (const [mode, weight] of FIDGETS) {
    acc += weight;
    if (u < acc) return mode;
  }
  return FIDGETS[FIDGETS.length - 1][0];
}

export function initialState(
  now: number,
  width: number,
  reducedMotion: boolean,
  sessionActive: boolean,
  rand: number,
  cell: Cell = DISPLAY_CELL,
): BirdState {
  const x = restingX(width, cell);
  const restUntil = now + restLength(mix(rand, 4));
  return {
    mode: sessionActive ? "sleep" : "idle",
    enteredAt: now,
    nextAt: Math.min(restUntil, now + fidgetGap(mix(rand, 5))),
    restUntil,
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

/** A new rest between walks: idle, or now and then perched, for a rest length. */
export function enterRest(s: BirdState, now: number, rand: number): BirdState {
  const restUntil = now + restLength(mix(rand, 4));
  const perched = mix(rand, 3) < PERCH_CHANCE;
  return {
    ...s,
    mode: perched ? "perch" : "idle",
    enteredAt: now,
    restUntil,
    nextAt: perched ? restUntil : Math.min(restUntil, now + fidgetGap(mix(rand, 5))),
    happyAfterWake: false,
  };
}

/** After a fidget: back to idle for what is left of the same rest. */
function backToRest(s: BirdState, now: number, rand: number): BirdState {
  if (s.sessionActive) return { ...s, mode: "sleep", enteredAt: now, happyAfterWake: false };
  return { ...s, mode: "idle", enteredAt: now, nextAt: Math.min(s.restUntil, now + fidgetGap(mix(rand, 5))) };
}

/** Where anything that ended goes: asleep if a session is running, else a new rest. */
const settle = (s: BirdState, now: number, rand: number): BirdState =>
  s.sessionActive ? { ...s, mode: "sleep", enteredAt: now, happyAfterWake: false } : enterRest(s, now, rand);

/** A walk of about this long, this way, or null if it can't go that way. */
export function beginWalk(s: BirdState, now: number, facing: 1 | -1, durationMs: number): BirdState | null {
  const turning = facing !== s.facing && !s.reducedMotion;
  const steps = walkStepsFor(durationMs, s.x, facing, turning, s.width, s.cell);
  if (steps === 0) return null;
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

/**
 * The rest is over: walk for WALK_MIN_MS to WALK_MAX_MS, mostly on the way it
 * faces, else back the other way, whichever has room; if neither has, rest again.
 * Turn first if it has to, then hold walk frame 0 for a frame without moving,
 * step a stride per frame, stop on a contact frame and hold it a frame.
 */
function startWalk(s: BirdState, now: number, rand: number): BirdState {
  const ahead: 1 | -1 = mix(rand, 1) < KEEP_GOING ? s.facing : s.facing === 1 ? -1 : 1;
  const duration = walkLength(mix(rand, 2));
  return beginWalk(s, now, ahead, duration) ?? beginWalk(s, now, ahead === 1 ? -1 : 1, duration) ?? enterRest(s, now, rand);
}

function tick(s: BirdState, now: number, rand: number): BirdState {
  const elapsed = now - s.enteredAt;
  switch (s.mode) {
    case "idle":
      if (s.reducedMotion || now < s.nextAt) return s;
      if (now >= s.restUntil) return startWalk(s, now, rand);
      // A fidget that couldn't finish inside the rest would stretch it: wait for the walk instead.
      if (now + FIDGET_LONGEST_MS > s.restUntil) return { ...s, nextAt: s.restUntil };
      return { ...s, mode: pickFidget(mix(rand, 6)), enteredAt: now };
    case "perch":
      if (s.reducedMotion || now < s.restUntil) return s;
      return startWalk(s, now, rand);
    case "walk": {
      const walked = now - s.stepAt;
      if (walked < 0) return s; // still turning: nothing moves
      const n = Math.floor((walked * rowOf("walk").fps) / 1000);
      // The last frame, a contact frame at the target, has had its frame-time.
      if (n > s.walkSteps) return enterRest({ ...s, x: s.targetX }, now, rand);
      return { ...s, x: s.fromX + s.facing * n * walkStride() };
    }
    case "peck":
      return playedOnce(rowOf("peck"), elapsed) ? backToRest(s, now, rand) : s;
    case "preen":
      return playedOnce(rowOf("idle_preen"), elapsed) ? backToRest(s, now, rand) : s;
    case "mutter":
      return elapsed >= MUTTER_MS ? backToRest(s, now, rand) : s;
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
      return s.mode === "walk" ? enterRest(resized, now, rand) : resized;
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
      if (!event.reduced) {
        const moving = { ...s, reducedMotion: false };
        return s.mode === "idle" || s.mode === "perch" ? enterRest(moving, now, rand) : moving;
      }
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
  if (s.mode === "preen") return "idle_preen";
  if (s.mode === "mutter") return "talk";
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
  // The next frame step, or sooner if a fidget or the walk is due before it.
  const step = STILL_STEP_MS - ((now - s.enteredAt) % STILL_STEP_MS);
  return { kind: "wait", ms: s.mode === "sleep" ? step : Math.max(0, Math.min(step, s.nextAt - now)) };
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
