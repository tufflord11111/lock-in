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

/**
 * Where a frame's pixels are opaque enough to see (alpha over `min`): the box
 * round them, in the image's own pixels, or null for an empty frame.
 */
export function alphaBounds(data: ArrayLike<number>, width: number, height: number, min = 24): Box | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > min) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * The bird's drawn pixels on the screen: `ink`, the frame's opaque box in the
 * cell (CSS px, as the art faces, right), placed the way the cell is, flipped
 * about the cell's middle while it faces left (scaleX < 0), and lowered by `dy`
 * (rowDy on the branch). Mid-turn it covers both ways. This, not the whole
 * cell, is what takes the cursor: most of the cell is empty, and a window under
 * it (the dashboard's list) must keep its hover there.
 */
export function inkBox(s: { x: number; lift: number; cell: Cell }, innerHeight: number, ink: Box, scaleX: number, dy = 0): Box {
  const top = innerHeight - s.cell.height - s.lift + dy + ink.y;
  const right = { x: s.x + ink.x, w: ink.w };
  const left = { x: s.x + s.cell.width - ink.x - ink.w, w: ink.w };
  if (scaleX >= 1) return { x: right.x, y: top, w: right.w, h: ink.h };
  if (scaleX <= -1) return { x: left.x, y: top, w: left.w, h: ink.h };
  const x = Math.min(right.x, left.x);
  return { x, y: top, w: Math.max(right.x + right.w, left.x + left.w) - x, h: ink.h };
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
