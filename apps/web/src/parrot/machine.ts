/**
 * The bird's state machine. A pure reducer: no DOM, no timers, no Math.random;
 * time and randomness arrive as arguments. Coordinates are CSS px: x is the
 * cell's left edge, lift is the height of the feet above the bottom edge. The
 * cell is the bird's box in CSS px; it need not be square.
 */
import { DISPLAY_CELL, playedOnce, rowOf, type DisplayCell, type LoopPlan } from "./animator";
import { birdBox } from "./layout";
import { BRANCH, DROP_ON_PERCH_PX, INTO_SCREEN, boxGap, branchBox, perchSpot, type Branch } from "./perch";

type Cell = DisplayCell;

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
  | "fall"
  | "flight";

/** A place the bird can be: x is the cell's left edge, lift the feet's height above the bottom edge. */
export type Spot = { x: number; lift: number };

/**
 * One flight: turn first if it has to (until takeoffAt), the takeoff row in
 * place, the fly row along the arc (until landAt), and at the perch a turn in
 * the air to face into the screen (until landRowAt), then the land row in place.
 */
export type Flight = {
  from: Spot;
  to: Spot;
  takeoffAt: number;
  flyAt: number;
  landAt: number;
  landRowAt: number;
  endAt: number;
  toBranch: boolean;
  /** It set off from the branch: its feet are on it until the takeoff row is done. */
  fromBranch: boolean;
};

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
  /** The window's width and height in CSS px. */
  width: number;
  height: number;
  /** On the branch at the right edge, rather than the bottom edge. */
  onBranch: boolean;
  /** The branch as the overlay draws it, CSS px: where its perch is. */
  branch: Branch;
  /** flight: where from, where to, and when each part of it happens. */
  flight: Flight | null;
  /** A bubble or the menu is open, whatever the mode. */
  talking: boolean;
  /** A session ended with the bird on the branch: the next rest there is short. */
  leaveSoon: boolean;
  /** Outside sessions, the next visit to the branch is due from here: BRANCH_GAP after it last left. */
  branchDueAt: number;
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
  | { type: "resize"; width: number; height?: number; branch?: Branch }
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

/**
 * Turning round: scaleX eases to TURN_MIN_SCALE, flips, eases back, over
 * TURN_MS, dipping TURN_DIP_PX at the middle. Never thinner than a third: at
 * 0.08 the bird became a white stripe for a few frames, which read as it
 * vanishing (the v11 "flash", found by the debug frame check).
 */
export const TURN_MS = 160;
export const TURN_MIN_SCALE = 0.35;
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

/*
 * Flight: the takeoff row in place, the fly row along an arc that eases in and
 * out and rises ARC_PEAK_PX above the straight line at its middle, at about
 * FLY_PX_PER_S, then the land row in place.
 *
 * Outside a session the branch is a now-and-then thing: a visit comes
 * BRANCH_GAP_MIN_MS to BRANCH_GAP_MAX_MS after the bird last left it (or
 * started), at the end of the first walk after that, and lasts
 * BRANCH_STAY_MIN_MS to BRANCH_STAY_MAX_MS, idling, preening every
 * BRANCH_FIDGET_MIN_MS to BRANCH_FIDGET_MAX_MS, and blinking, before it flies
 * down. After a session it stays LEAVE_MIN_MS to LEAVE_MAX_MS once awake.
 */
export const FLY_PX_PER_S = 350;
export const ARC_PEAK_PX = 80;
export const BRANCH_GAP_MIN_MS = 10 * 60_000;
export const BRANCH_GAP_MAX_MS = 15 * 60_000;
export const BRANCH_STAY_MIN_MS = 2 * 60_000;
export const BRANCH_STAY_MAX_MS = 5 * 60_000;
export const BRANCH_FIDGET_MIN_MS = 8_000;
export const BRANCH_FIDGET_MAX_MS = 20_000;
export const LEAVE_MIN_MS = 2_000;
export const LEAVE_MAX_MS = 5_000;
/** Until the overlay says how tall it is: a typical work area. */
export const DEFAULT_HEIGHT = 900;

export const rowMs = (state: string): number => (rowOf(state).frames * 1000) / rowOf(state).fps;
export const easeInOut = (u: number): number => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, u)))) / 2;

/** The arc at s (0 to 1 along it, eased): the straight line, raised by a half sine. */
export function arcPoint(from: Spot, to: Spot, s: number): Spot {
  return {
    x: from.x + (to.x - from.x) * s,
    lift: from.lift + (to.lift - from.lift) * s + ARC_PEAK_PX * Math.sin(Math.PI * s),
  };
}

export function arcLength(from: Spot, to: Spot): number {
  const N = 64;
  let length = 0;
  let prev = from;
  for (let i = 1; i <= N; i++) {
    const p = arcPoint(from, to, i / N);
    length += Math.hypot(p.x - prev.x, p.lift - prev.lift);
    prev = p;
  }
  return length;
}

/** How long the fly row plays: the arc's length at FLY_PX_PER_S. */
export const flyMs = (from: Spot, to: Spot): number => (arcLength(from, to) / FLY_PX_PER_S) * 1000;

/** Where the perch puts the bird in this window. */
export const perchFor = (s: { width: number; height: number; cell: Cell; branch?: Branch }): Spot =>
  perchSpot(s.width, s.height, s.cell, s.branch ?? BRANCH);

/**
 * Never under reduced motion, while hidden, or while a bubble or the menu is
 * open. A session's own flight up to the perch is the only one during a session.
 */
export const canFly = (s: BirdState): boolean => !s.reducedMotion && !s.hidden && !s.talking;

/** Facing the way it goes, turning first if it must, then up, along and down. */
export function beginFlight(s: BirdState, now: number, to: Spot, toBranch: boolean): BirdState {
  const facing: 1 | -1 = to.x === s.x ? s.facing : to.x > s.x ? 1 : -1;
  const holdRow = spriteState(s, now);
  const holdFrame = frameIndex(s, now, () => 0);
  const turned = faceTo(s, facing, now);
  const from = { x: s.x, lift: s.lift };
  const takeoffAt = turned !== s && turned.turnStart === now ? now + TURN_MS : now;
  const flyAt = takeoffAt + rowMs("takeoff");
  const landAt = flyAt + flyMs(from, to);
  // It lands on the perch facing into the screen, so one that flew in facing the edge turns first.
  const landRowAt = landAt + (toBranch && facing !== INTO_SCREEN && !s.reducedMotion ? TURN_MS : 0);
  return {
    ...turned,
    mode: "flight",
    enteredAt: now,
    stepAt: takeoffAt,
    holdRow,
    holdFrame,
    onBranch: false,
    flight: { from, to, takeoffAt, flyAt, landAt, landRowAt, endAt: landRowAt + rowMs("land"), toBranch, fromBranch: s.onBranch },
  };
}

/** Dropped by the branch: onto the perch at once, then the land row. Under reduced motion, just there. */
function dropOntoPerch(s: BirdState, now: number, rand: number): BirdState {
  const spot = perchFor(s);
  if (s.reducedMotion) return settle({ ...teleport(s, spot, true), restUntil: 0 }, now, rand);
  return {
    ...faceTo(teleport(s, spot, false), INTO_SCREEN, now),
    mode: "flight",
    enteredAt: now,
    stepAt: now,
    flight: { from: spot, to: spot, takeoffAt: now, flyAt: now, landAt: now, landRowAt: now, endAt: now + rowMs("land"), toBranch: true, fromBranch: false },
  };
}

/** Straight there with no animation: under reduced motion, hidden, or with a bubble open. On the perch, facing in. */
const teleport = (s: BirdState, to: Spot, onBranch: boolean): BirdState => ({
  ...s,
  x: to.x,
  lift: to.lift,
  onBranch,
  flight: null,
  ...(onBranch ? { facing: INTO_SCREEN, turnStart: null } : {}),
});

/** A random spot on the bottom edge to fly down to. */
const groundSpot = (s: BirdState, u: number): Spot => ({ x: Math.round(u * maxX(s.width, s.cell)), lift: 0 });

/** Off the branch now: the next visit is a gap away. */
const leftBranch = (s: BirdState, now: number, rand: number): BirdState => ({ ...s, branchDueAt: now + branchGap(mix(rand, 10)) });

/** The rest on the branch is over: fly down, or where it may not fly, be there. */
function leaveBranch(s: BirdState, now: number, rand: number): BirdState {
  if (s.reducedMotion || s.hidden) {
    const to = s.reducedMotion ? { x: restingX(s.width, s.cell), lift: 0 } : groundSpot(s, mix(rand, 9));
    return enterRest(leftBranch(teleport(s, to, false), now, rand), now, rand);
  }
  // A bubble or the menu is open: ask again shortly.
  if (s.talking) return { ...s, nextAt: now + STILL_STEP_MS };
  return beginFlight(leftBranch(s, now, rand), now, groundSpot(s, mix(rand, 9)), false);
}

/** The bird is wherever the flight was going, its flight over. */
function arrive(s: BirdState, now: number, rand: number): BirdState {
  const f = s.flight as Flight;
  const landed = { ...teleport(s, f.to, f.toBranch), enteredAt: now };
  // On the branch it rests, or sleeps in a session. Back on the ground the rest is over: walk.
  if (landed.sessionActive) return settle(landed, now, rand);
  // A visit starts: its stay is counted from now.
  if (f.toBranch) return enterRest({ ...landed, restUntil: 0 }, now, rand);
  return startWalk(landed, now, rand);
}
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
export const branchGap = (u: number) => between(u, BRANCH_GAP_MIN_MS, BRANCH_GAP_MAX_MS);
export const branchStay = (u: number) => between(u, BRANCH_STAY_MIN_MS, BRANCH_STAY_MAX_MS);
export const branchFidgetGap = (u: number) => between(u, BRANCH_FIDGET_MIN_MS, BRANCH_FIDGET_MAX_MS);
/** How long until the next fidget, where it is. */
const nextFidget = (s: BirdState, u: number) => (s.onBranch ? branchFidgetGap(u) : fidgetGap(u));

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
  height: number = DEFAULT_HEIGHT,
): BirdState {
  const x = restingX(width, cell);
  const restUntil = now + restLength(mix(rand, 4));
  // In a session already: asleep on the perch, put there.
  const perch = sessionActive ? perchSpot(width, height, cell, BRANCH) : null;
  return {
    mode: sessionActive ? "sleep" : "idle",
    enteredAt: now,
    nextAt: Math.min(restUntil, now + fidgetGap(mix(rand, 5))),
    restUntil,
    x: perch?.x ?? x,
    lift: perch?.lift ?? 0,
    targetX: x,
    fromX: x,
    fromLift: 0,
    facing: perch ? INTO_SCREEN : 1,
    turnStart: null,
    turnFrom: 1,
    stepAt: now,
    walkSteps: 0,
    holdRow: "idle",
    holdFrame: 0,
    width,
    height,
    onBranch: perch !== null,
    branch: BRANCH,
    flight: null,
    talking: false,
    leaveSoon: false,
    branchDueAt: now + branchGap(mix(rand, 10)),
    cell,
    hidden: false,
    reducedMotion,
    sessionActive,
    happyAfterWake: false,
  };
}

/**
 * A new rest between walks: idle, or now and then perched, for a rest length.
 * On the branch always idle, until the visit's stay is over (a talk there
 * doesn't restart it); a visit that starts now stays BRANCH_STAY_MIN_MS to
 * BRANCH_STAY_MAX_MS; just after a session, only LEAVE_MIN_MS to LEAVE_MAX_MS.
 */
export function enterRest(s: BirdState, now: number, rand: number): BirdState {
  if (s.onBranch) {
    const until = s.leaveSoon
      ? now + between(mix(rand, 8), LEAVE_MIN_MS, LEAVE_MAX_MS)
      : s.restUntil > now
        ? s.restUntil
        : now + branchStay(mix(rand, 4));
    return {
      ...s,
      mode: "idle",
      enteredAt: now,
      restUntil: until,
      nextAt: s.reducedMotion ? until : Math.min(until, now + branchFidgetGap(mix(rand, 5))),
      leaveSoon: false,
      happyAfterWake: false,
    };
  }
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
  return { ...s, mode: "idle", enteredAt: now, nextAt: Math.min(s.restUntil, now + nextFidget(s, mix(rand, 5))) };
}

/** After a walk: up to the branch if a visit is due and it may fly, else a rest on the ground. */
function restAfterWalk(s: BirdState, now: number, rand: number): BirdState {
  if (!s.sessionActive && canFly(s) && now >= s.branchDueAt) return beginFlight(s, now, perchFor(s), true);
  return enterRest(s, now, rand);
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
      if (s.onBranch) {
        if (now < s.nextAt) return s;
        if (now >= s.restUntil) return leaveBranch(s, now, rand);
        // On the branch it preens; under reduced motion it waits for the rest to end.
        if (s.reducedMotion || now + FIDGET_LONGEST_MS > s.restUntil) return { ...s, nextAt: s.restUntil };
        return { ...s, mode: "preen", enteredAt: now };
      }
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
      if (n > s.walkSteps) return restAfterWalk({ ...s, x: s.targetX }, now, rand);
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
    case "flight": {
      const f = s.flight;
      if (!f) return settle(s, now, rand);
      if (now >= f.endAt) return arrive(s, now, rand);
      if (now < f.flyAt) return s.x === f.from.x && s.lift === f.from.lift ? s : { ...s, ...f.from };
      if (now >= f.landAt) {
        // At the perch: turn in the air to face into the screen, from the moment it got there.
        const there = { ...s, ...f.to };
        return f.toBranch && there.facing !== INTO_SCREEN ? faceTo(there, INTO_SCREEN, f.landAt) : there;
      }
      return { ...s, ...arcPoint(f.from, f.to, easeInOut((now - f.flyAt) / (f.landAt - f.flyAt))) };
    }
    case "fall": {
      const lift = s.fromLift - (FALL_PX_PER_S * elapsed) / 1000;
      return lift <= 0 ? settle({ ...s, lift: 0 }, now, rand) : { ...s, lift };
    }
    default:
      return s;
  }
}

/**
 * The perch rule, whatever else happened: on the branch it faces into the
 * screen. Nothing on the perch turns it, so this only catches a mistake.
 */
function facingIn(s: BirdState): BirdState {
  return s.onBranch && s.facing !== INTO_SCREEN ? { ...s, facing: INTO_SCREEN, turnStart: null } : s;
}

export function reduce(s: BirdState, event: BirdEvent, now: number, rand: number): BirdState {
  const next = step(s, event, now, rand);
  return next === s ? s : facingIn(next);
}

function step(s: BirdState, event: BirdEvent, now: number, rand: number): BirdState {
  switch (event.type) {
    case "tick":
      return tick(s, now, rand);
    case "resize": {
      const sized = { ...s, width: event.width, height: event.height ?? s.height, branch: event.branch ?? s.branch };
      // The perch moves with the window's edges; a flight in the air finishes where it was going.
      if (s.mode === "flight" && s.flight) {
        const to = s.flight.toBranch ? perchFor(sized) : { x: Math.min(s.flight.to.x, maxX(sized.width, s.cell)), lift: 0 };
        return arrive({ ...sized, flight: { ...s.flight, to } }, now, rand);
      }
      if (s.onBranch) return { ...sized, ...perchFor(sized) };
      if (s.reducedMotion) return { ...sized, x: restingX(event.width, s.cell) };
      const resized = { ...sized, x: Math.min(s.x, maxX(event.width, s.cell)) };
      // A walk's end point may now be off the screen.
      return s.mode === "walk" ? enterRest(resized, now, rand) : resized;
    }
    case "session": {
      if (event.active === s.sessionActive) return s;
      if (event.active) {
        // To the perch to sleep: one flight, or straight there when it may not fly.
        const on = { ...s, sessionActive: true };
        if (s.mode === "drag") return on;
        if (s.onBranch) return { ...on, mode: "sleep", enteredAt: now, happyAfterWake: false };
        if (s.mode === "flight" && s.flight?.toBranch) return on;
        if (canFly(on)) return beginFlight(on, now, perchFor(on), true);
        return { ...teleport(on, perchFor(on), true), mode: "sleep", enteredAt: now, happyAfterWake: false };
      }
      const off = { ...s, sessionActive: false, leaveSoon: headedForBranch(s) };
      return s.mode === "sleep" ? { ...off, mode: "wake", enteredAt: now } : off;
    }
    case "stoodDown": {
      const happyAfterWake = event.finished;
      const off = { ...s, sessionActive: false, leaveSoon: s.leaveSoon || (s.sessionActive && headedForBranch(s)) };
      if (s.mode === "sleep") return { ...off, mode: "wake", enteredAt: now, happyAfterWake };
      // The poll may have woken the bird a moment before this event arrived.
      if (s.mode === "wake") return { ...off, happyAfterWake };
      return off;
    }
    case "hidden":
      return { ...s, hidden: event.hidden };
    case "reducedMotion":
      if (event.reduced === s.reducedMotion) return s;
      if (!event.reduced) {
        const moving = { ...s, reducedMotion: false };
        return s.mode === "idle" || s.mode === "perch" ? enterRest(moving, now, rand) : moving;
      }
      {
        const still = { ...s, reducedMotion: true };
        // In the air: at once where it was going. On the branch it stays.
        if (s.mode === "flight" && s.flight) return settle(teleport(still, s.flight.to, s.flight.toBranch), now, rand);
        if (s.onBranch) return settle(still, now, rand);
        return settle({ ...still, x: restingX(s.width, s.cell), lift: 0 }, now, rand);
      }
    case "talkStart":
      if (s.mode === "drag" || s.mode === "sleep" || s.mode === "fall" || s.mode === "flight") return { ...s, talking: true };
      return { ...s, mode: "talk", enteredAt: now, talking: true };
    case "talkEnd": {
      const quiet = { ...s, talking: false };
      return s.mode === "talk" ? settle(quiet, now, rand) : quiet;
    }
    case "dragStart": {
      // fromX: where it was picked up, so a bird lifted off the perch, which overhangs the edge, doesn't jump.
      const lifted = { ...s, mode: "drag" as const, enteredAt: now, onBranch: false, flight: null, fromX: s.x };
      return s.onBranch ? leftBranch(lifted, now, rand) : lifted;
    }
    case "dragMove":
      if (s.mode !== "drag") return s;
      return {
        ...s,
        // On the screen; a bird lifted off the perch may stay as far right as it was.
        x: Math.min(Math.max(0, event.x), Math.max(maxX(s.width, s.cell), s.fromX)),
        lift: Math.min(Math.max(0, event.lift), Math.max(0, event.maxLift)),
      };
    case "dragEnd": {
      if (s.mode !== "drag") return s;
      if (nearBranch(s)) return dropOntoPerch(s, now, rand);
      const onScreen = { ...s, x: Math.min(s.x, maxX(s.width, s.cell)) };
      if (s.reducedMotion || s.lift === 0) return settle({ ...onScreen, lift: 0 }, now, rand);
      return { ...onScreen, mode: "fall", enteredAt: now, fromLift: s.lift };
    }
  }
}

/** On the branch, or on its way there. */
const headedForBranch = (s: BirdState): boolean => s.onBranch || (s.mode === "flight" && s.flight?.toBranch === true);

/** Dropped within DROP_ON_PERCH_PX of the branch. */
export const nearBranch = (s: BirdState): boolean =>
  boxGap(birdBox(s, s.height), branchBox(s.width, s.height, s.branch)) <= DROP_ON_PERCH_PX;

/**
 * The sprite row to draw. `fall` has no row in the sheet; it reuses `drag`. A
 * walk that is still turning shows the row it started from.
 */
export function spriteState(s: BirdState, now: number): string {
  if (s.mode === "fall") return "drag";
  if (s.mode === "preen") return "idle_preen";
  if (s.mode === "mutter") return "talk";
  if (s.mode === "walk" && now < s.stepAt) return s.holdRow;
  if (s.mode === "flight") {
    const f = s.flight;
    if (!f) return "fly";
    if (now < f.takeoffAt) return s.holdRow;
    if (now < f.flyAt) return "takeoff";
    if (now < f.landRowAt) return "fly";
    return "land";
  }
  return s.mode;
}

/**
 * What each mode may draw next, beside its own row, most likely first: these
 * are decoded ahead, so a change of row never waits for a decode.
 */
const NEXT_ROWS: Record<Mode, readonly string[]> = {
  idle: ["walk", "peck", "idle_preen", "talk", "takeoff", "drag"],
  // A walk or a flight that starts with a turn shows the row it came from until it has turned.
  walk: ["walk", "idle", "takeoff", "perch", "talk", "drag"],
  peck: ["idle", "walk", "talk", "takeoff", "drag"],
  preen: ["idle", "walk", "talk", "takeoff", "drag"],
  mutter: ["idle", "walk", "takeoff", "drag"],
  perch: ["walk", "talk", "takeoff", "drag"],
  sleep: ["wake", "drag"],
  wake: ["happy", "idle", "idle_preen", "takeoff"],
  happy: ["idle", "idle_preen", "takeoff", "walk"],
  talk: ["idle", "perch", "sleep", "walk", "takeoff", "drag"],
  drag: ["land", "idle", "sleep", "perch", "walk"],
  fall: ["idle", "sleep", "perch", "walk"],
  flight: ["takeoff", "fly", "land", "idle", "walk", "sleep"],
};
/** On the branch a rest preens, talks, sleeps or flies down. */
const NEXT_ON_BRANCH: readonly string[] = ["idle_preen", "takeoff", "fly", "talk", "sleep", "drag"];

/** The row it is drawing, then the rows it may draw next. */
export function nextRows(s: BirdState, now: number): string[] {
  const here = spriteState(s, now);
  const next = s.onBranch && (s.mode === "idle" || s.mode === "preen") ? ["idle", ...NEXT_ON_BRANCH] : NEXT_ROWS[s.mode];
  return [...new Set([here, ...next])];
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
  if (s.hidden) return { kind: "stop" };
  // Still under reduced motion, but a rest on the branch ends with a jump down.
  if (s.reducedMotion && s.onBranch && s.mode === "idle" && !s.sessionActive) return { kind: "wait", ms: Math.max(0, s.restUntil - now) };
  if (holdsOneFrame(s)) return { kind: "stop" };
  if (isTurning(s, now)) return { kind: "frames" };
  if (s.mode === "walk") return { kind: "wait", ms: WALK_STEP_MS };
  if (!isStill(s)) return { kind: "frames" };
  // The next frame step, or sooner if a fidget or the walk is due before it.
  const step = STILL_STEP_MS - ((now - s.enteredAt) % STILL_STEP_MS);
  return { kind: "wait", ms: s.mode === "sleep" ? step : Math.max(0, Math.min(step, s.nextAt - now)) };
}

/** The frame to show. Still modes step slowly from the clock; reduced motion holds frame 0. */
export function frameIndex(s: BirdState, now: number, frameAt: (state: string, elapsedMs: number) => number): number {
  if (s.mode === "flight" && s.flight) {
    const f = s.flight;
    if (now < f.takeoffAt) return s.holdFrame;
    if (now < f.flyAt) return frameAt("takeoff", now - f.takeoffAt);
    if (now < f.landRowAt) return frameAt("fly", now - f.flyAt);
    return frameAt("land", now - f.landRowAt);
  }
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
