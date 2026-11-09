/**
 * Petting: a right-button rub on the bird. Pure timing and pose, no DOM; the
 * machine keeps a Pet in its state and the overlay draws from it.
 *
 * A right press on the bird that moves PET_START_PX starts it; a right click
 * alone does nothing. The pet row plays its opening frames (0 to 1), loops on
 * its held frames (meta.loops.pet, 2 to 3) while the hand keeps rubbing, and
 * plays its closing frames (4 to 5) once the rub stops: no movement for
 * PET_IDLE_MS, or the button let go. Meanwhile the bird leans PET_LEAN_DEG
 * toward the cursor. Under reduced motion it holds the first held frame and
 * doesn't lean.
 */
import { rowOf, type SpriteRow } from "./animator";

export const PET_START_PX = 3;
export const PET_IDLE_MS = 400;
export const PET_LEAN_DEG = 2.5;
/** Asleep it isn't woken: its feathers only fluff out this much and back while rubbed. */
export const PET_FLUFF_SCALE = 1.02;

/**
 * One petting. `startAt` is when the opening frames began, `lastRubAt` the
 * last movement of the hand, `stopAt` when the rub stopped (null while it
 * goes on). `back` is the mode it returns to afterwards.
 */
export type Pet = {
  startAt: number;
  lastRubAt: number;
  stopAt: number | null;
  back: string;
};

const frameMs = (row: SpriteRow) => 1000 / row.fps;

/** The row's held frames: meta.loops, else its middle two. */
export function heldFrames(row: SpriteRow = rowOf("pet")): { from: number; to: number } {
  return row.loopFrames ?? { from: Math.max(0, Math.floor(row.frames / 2) - 1), to: Math.floor(row.frames / 2) };
}

/** How long the opening and the closing frames play. */
export function petTimes(row: SpriteRow = rowOf("pet")): { openMs: number; closeMs: number } {
  const { from, to } = heldFrames(row);
  return { openMs: from * frameMs(row), closeMs: (row.frames - 1 - to) * frameMs(row) };
}

/** When the hand stopped: let go, else PET_IDLE_MS after it last moved, if that has passed. */
export function stoppedAt(p: Pet, now: number): number | null {
  if (p.stopAt !== null) return p.stopAt;
  return now >= p.lastRubAt + PET_IDLE_MS ? p.lastRubAt + PET_IDLE_MS : null;
}

/** When the closing frames start: once the rub has stopped, but never before the opening is done. */
export function closeAt(p: Pet, now: number, row: SpriteRow = rowOf("pet")): number | null {
  const stop = stoppedAt(p, now);
  return stop === null ? null : Math.max(stop, p.startAt + petTimes(row).openMs);
}

/** When the petting is over. Under reduced motion, as soon as the rub stops. */
export function petEndAt(p: Pet, now: number, reduced: boolean, row: SpriteRow = rowOf("pet")): number | null {
  if (reduced) return stoppedAt(p, now);
  const close = closeAt(p, now, row);
  return close === null ? null : close + petTimes(row).closeMs;
}

/** The pet row's frame now: opening, the held loop while rubbed, then closing. Reduced motion: the first held frame. */
export function petFrame(p: Pet, now: number, reduced: boolean, row: SpriteRow = rowOf("pet")): number {
  const { from, to } = heldFrames(row);
  if (reduced) return from;
  const ms = frameMs(row);
  const { openMs } = petTimes(row);
  const close = closeAt(p, now, row);
  if (close !== null && now >= close) return Math.min(row.frames - 1, to + 1 + Math.floor((now - close) / ms));
  if (now < p.startAt + openMs) return Math.max(0, Math.floor((now - p.startAt) / ms));
  return from + (Math.floor((now - p.startAt - openMs) / ms) % (to - from + 1));
}

/**
 * How far it leans toward the cursor now, degrees, clockwise on the screen:
 * `side` is +1 with the cursor right of its head, -1 left of it, 0 unknown.
 * Eases in over the opening frames and out over the closing ones. None under
 * reduced motion.
 */
export function petLean(p: Pet, now: number, reduced: boolean, side: -1 | 0 | 1, row: SpriteRow = rowOf("pet")): number {
  if (reduced || side === 0) return 0;
  const { openMs, closeMs } = petTimes(row);
  const ease = (u: number) => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, u)))) / 2;
  const close = closeAt(p, now, row);
  const into = openMs > 0 ? ease((now - p.startAt) / openMs) : 1;
  const out = close === null || now < close ? 1 : closeMs > 0 ? 1 - ease((now - close) / closeMs) : 0;
  return side * PET_LEAN_DEG * Math.min(into, out);
}

/** Which side of the head the cursor is, with a few px of dead band so it doesn't flicker over the middle. */
export function cursorSide(cursorX: number, headX: number, previous: -1 | 0 | 1): -1 | 0 | 1 {
  if (cursorX > headX + 2) return 1;
  if (cursorX < headX - 2) return -1;
  return previous;
}
