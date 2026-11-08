/**
 * The blink: a lid drawn over the art's eye, on its own clock. Pure: time and
 * randomness arrive as arguments, and the DOM is bird.ts's job.
 *
 * A blink is open, half, closed, half, open over BLINK_MS. They come every
 * BLINK_MIN_GAP_MS to BLINK_MAX_GAP_MS at random, and one in five is a double.
 * Only in BLINK_ROWS, never asleep, hidden or under reduced motion, and only
 * on frames whose eye the art shows open.
 */
import type { Eye, LoopPlan } from "./animator";

export const BLINK_ROWS: readonly string[] = ["idle", "walk", "talk", "peck", "perch"];
export const BLINK_MIN_GAP_MS = 3_000;
export const BLINK_MAX_GAP_MS = 7_000;
export const DOUBLE_CHANCE = 0.2;
/** Each of half, closed, half. */
export const LID_STEP_MS = 50;
export const BLINK_MS = 3 * LID_STEP_MS;
/** Open between the two blinks of a double. */
export const DOUBLE_GAP_MS = 100;

/** How far the lid is down: open, half or closed. */
export type Lid = 0 | 0.5 | 1;

export type Blink = {
  /** When the next blink is due, while none is running. */
  nextAt: number;
  /** When the running blink began, or null. */
  startAt: number | null;
  double: boolean;
};

export const blinkGap = (rand: number) => BLINK_MIN_GAP_MS + rand * (BLINK_MAX_GAP_MS - BLINK_MIN_GAP_MS);
export const blinkLength = (double: boolean) => (double ? 2 * BLINK_MS + DOUBLE_GAP_MS : BLINK_MS);

export const firstBlink = (now: number, rand: number): Blink => ({ nextAt: now + blinkGap(rand), startAt: null, double: false });

/** Whether the bird may blink now, given the row it is drawing. */
export function canBlink(s: { mode: string; reducedMotion: boolean; hidden: boolean }, row: string): boolean {
  return s.mode !== "sleep" && !s.reducedMotion && !s.hidden && BLINK_ROWS.includes(row);
}

/**
 * Moves the blink on. A due blink starts if the bird can blink, else it is
 * skipped and the next one is scheduled. A running blink ends when it is done,
 * or at once if the bird can no longer blink.
 */
export function stepBlink(b: Blink, now: number, eligible: boolean, randGap: number, randDouble: number): Blink {
  if (b.startAt !== null) {
    if (eligible && now - b.startAt < blinkLength(b.double)) return b;
    return { nextAt: now + blinkGap(randGap), startAt: null, double: false };
  }
  if (now < b.nextAt) return b;
  if (!eligible) return { nextAt: now + blinkGap(randGap), startAt: null, double: false };
  return { nextAt: b.nextAt, startAt: now, double: randDouble < DOUBLE_CHANCE };
}

/** The lid now: half, closed, half, then open; a double does it twice with a gap. */
export function lidAt(b: Blink, now: number): Lid {
  if (b.startAt === null) return 0;
  let t = now - b.startAt;
  if (b.double && t >= BLINK_MS) {
    if (t < BLINK_MS + DOUBLE_GAP_MS) return 0;
    t -= BLINK_MS + DOUBLE_GAP_MS;
  }
  if (t < 0 || t >= BLINK_MS) return 0;
  return t < LID_STEP_MS ? 0.5 : t < 2 * LID_STEP_MS ? 1 : 0.5;
}

/** The skip rule: a lid only over an eye the art shows open. Missing, null or shut: none. */
export function lidOver(eye: Eye | null | undefined, lid: Lid): { eye: Eye; lid: Lid } | null {
  if (lid === 0 || !eye || eye.open !== true) return null;
  return { eye, lid };
}

/** What the blink needs from the loop: nothing if it can't blink, every frame while blinking, else a wake-up when due. */
export function blinkPlan(b: Blink, now: number, eligible: boolean): LoopPlan {
  if (!eligible) return { kind: "stop" };
  if (b.startAt !== null) return { kind: "frames" };
  return { kind: "wait", ms: Math.max(0, b.nextAt - now) };
}

/** Two plans as one: every frame if either wants it, else the sooner wake-up, else stop. */
export function combinePlans(a: LoopPlan, b: LoopPlan): LoopPlan {
  if (a.kind === "frames" || b.kind === "frames") return { kind: "frames" };
  if (a.kind === "wait" && b.kind === "wait") return { kind: "wait", ms: Math.min(a.ms, b.ms) };
  if (a.kind === "wait") return a;
  if (b.kind === "wait") return b;
  return { kind: "stop" };
}

/**
 * The lid's box in the display cell, CSS px: a disc a little larger than the
 * eye, so the art's anti-aliased rim is covered, and how far down it is filled.
 * Half covers to the eye's middle, closed to its bottom, where the lid's ink
 * edge sits.
 */
export function lidBox(eye: Eye, lid: Lid): { left: number; top: number; size: number; fill: number } {
  const radius = eye.r * 1.25;
  return {
    left: eye.x - radius,
    top: eye.y - radius,
    size: 2 * radius,
    fill: radius - eye.r + lid * 2 * eye.r,
  };
}
