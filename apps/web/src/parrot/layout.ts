/**
 * Where the bird's box is, in CSS px and in the overlay's physical px. Pure
 * functions of the state and the window, so the hitbox, the drag and the bubble
 * anchor all agree on one rectangle whatever the cell's width and height.
 */
import type { Cell } from "./animator";

export type Box = { x: number; y: number; w: number; h: number };

/** The bird's box in CSS px, measured from the window's top-left. */
export function birdBox(s: { x: number; lift: number; cell: Cell }, innerHeight: number): Box {
  return { x: s.x, y: innerHeight - s.cell.height - s.lift, w: s.cell.width, h: s.cell.height };
}

/** The same box in physical px, rounded, for Rust's hit-test. */
export function physicalBox(box: Box, dpr: number): Box {
  return { x: Math.round(box.x * dpr), y: Math.round(box.y * dpr), w: Math.round(box.w * dpr), h: Math.round(box.h * dpr) };
}

/**
 * Where on the bird's box the pointer pressed, in CSS px. Taken from the
 * state's box, not the element's drawn rectangle: the drawn one can trail the
 * state by a frame, and a lean or bob transform would change its size.
 */
export function grabOffset(pointer: { x: number; y: number }, box: Box): { x: number; y: number } {
  return { x: pointer.x - box.x, y: pointer.y - box.y };
}

/**
 * Where a drag puts the bird: the pointer minus where it grabbed the box, so
 * the bird stays under the finger. The machine clamps x and lift to the window.
 */
export function dragPosition(
  pointer: { x: number; y: number },
  grab: { x: number; y: number },
  innerHeight: number,
  cell: Cell,
): { x: number; lift: number; maxLift: number } {
  return {
    x: pointer.x - grab.x,
    lift: innerHeight - (pointer.y - grab.y) - cell.height,
    maxLift: innerHeight - cell.height,
  };
}

/** A card's left and bottom: centred over the bird, kept on the overlay, just above its head. */
export function cardAnchor(
  s: { x: number; lift: number; width: number; cell: Cell },
  cardWidth: number,
  gap: number,
): { left: number; bottom: number } {
  const left = Math.min(Math.max(gap, s.x + s.cell.width / 2 - cardWidth / 2), s.width - cardWidth - gap);
  return { left, bottom: s.lift + s.cell.height + gap };
}
