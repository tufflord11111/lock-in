/**
 * The contact shadow: a soft ellipse under the bird's footprint (the 1x sheet's
 * meta.contact, in CSS px, at every scale),
 * drawn after the branch and before the bird. Pure: the overlay places one
 * element from this, inside the bird's own box, so it moves, flips and fades
 * with the bird and costs nothing while the bird holds a frame.
 */
import { DISPLAY_CELL, contactAt } from "./animator";

/** The ellipse is the footprint's width times this, and this much of it tall. */
export const SHADOW_WIDTH = 1.1;
export const SHADOW_HEIGHT = 0.18;
/** Its soft edge, CSS px (so 3 device px at 1x). */
export const SHADOW_BLUR_PX = 3;
/** On the bark. On the ground there is none: the underband's border stands the bird on the edge instead. */
export const SHADOW_ALPHA_BRANCH = 0.35;
/** The rows where it is leaving the surface or coming down onto it: the shadow fades with the footprint. */
const LIFTING = ["takeoff", "land"];

/** The ellipse's box in the bird's cell, CSS px from its top-left facing right, and how dark it is. */
export type Shadow = { x: number; y: number; w: number; h: number; alpha: number };

/**
 * The shadow for this frame, on the branch: centred on the footprint, on the
 * feet line. None on the ground, and none where the art has the bird in the air. Taking off and landing it shrinks
 * with the footprint and fades as it does, against the footprint standing.
 */
export function shadowFor(row: string, frame: number, onBranch: boolean): Shadow | null {
  const c = contactAt(row, frame);
  if (!onBranch || !c || c.w <= 0) return null;
  const w = c.w * SHADOW_WIDTH;
  const h = c.w * SHADOW_HEIGHT;
  let alpha = SHADOW_ALPHA_BRANCH;
  if (LIFTING.includes(row)) {
    const standing = contactAt("idle", 0);
    if (standing && standing.w > 0) alpha *= Math.min(1, c.w / standing.w);
  }
  const baseline = DISPLAY_CELL.baseline ?? DISPLAY_CELL.height;
  return { x: c.cx - w / 2, y: baseline - h / 2, w, h, alpha };
}
