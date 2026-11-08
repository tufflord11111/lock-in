/**
 * The branch at the right edge and the perch on it. Pure geometry in CSS px,
 * measured from the overlay's top-left; the overlay is the bird's monitor's
 * work area, so the branch is on that monitor only.
 */
import manifest from "./sprites.manifest.json";
import type { DisplayCell } from "./animator";
import { birdBox, type Box } from "./layout";
import type { BirdState } from "./machine";

/** The branch's size and its perch point (where the bird's feet go), CSS px from its top-left. */
export type Branch = { width: number; height: number; perchX: number; perchY: number };

/** One drawing of the branch per sheet scale, in that drawing's px. */
export type BranchImage = { scale: number; file: string; width: number; height: number };

type Prop = { name: string; scale: number; file: string; width: number; height: number };
const m = manifest as { props?: Prop[]; branch?: Branch; ink?: Ink; displayCell: { width: number } };

/** How far the drawing reaches across the display cell in any frame: [left, right), CSS px from its left. */
export type Ink = { left: number; right: number };
export const INK: Ink = m.ink ?? { left: 0, right: m.displayCell.width };

/** The branch is on the right edge, so on it the bird faces left, into the screen. */
export const INTO_SCREEN = -1 as const;
/** Kept between the bird's drawing and the screen's right edge. */
export const PERCH_MARGIN_PX = 2;

export const BRANCH_IMAGES: BranchImage[] = (m.props ?? []).filter((p) => p.name === "branch");

/**
 * From the art's meta.branch. Without it, the 1x drawing's size with a guessed
 * perch: 45% in from the free (left) end, 55% of the way down.
 */
function branchFromManifest(): Branch {
  if (m.branch) return m.branch;
  const one = BRANCH_IMAGES.find((b) => b.scale === 1) ?? BRANCH_IMAGES[0];
  const width = one ? one.width / one.scale : 96;
  const height = one ? one.height / one.scale : 64;
  return { width, height, perchX: Math.round(width * 0.45), perchY: Math.round(height * 0.55) };
}
export const BRANCH: Branch = branchFromManifest();

/** The perch point sits this far down the work area. */
export const PERCH_HEIGHT = 0.55;
/** A drop this close to the branch lands on the perch. */
export const DROP_ON_PERCH_PX = 60;
/** While perched, a cursor this close to the bird or the branch fades them. */
export const FADE_NEAR_PX = 120;

/** The branch's box: flush with the right edge, its perch point PERCH_HEIGHT down. */
export function branchBox(width: number, height: number, b: Branch = BRANCH): Box {
  return { x: width - b.width, y: Math.round(height * PERCH_HEIGHT - b.perchY), w: b.width, h: b.height };
}

/**
 * Where the bird stands on the perch: x and lift, as the machine keeps them.
 * Feet on the perch point, centred; but moved in along the branch as far as it
 * takes to keep the whole drawing on the screen, facing in as it perches or
 * facing the edge as it arrives. `ink` defaults to the art's, for the art's cell.
 */
export function perchSpot(
  width: number,
  height: number,
  cell: DisplayCell,
  b: Branch = BRANCH,
  ink: Ink = cell.width === m.displayCell.width ? INK : { left: 0, right: cell.width },
): { x: number; lift: number } {
  const box = branchBox(width, height, b);
  const feetX = box.x + b.perchX;
  const feetY = box.y + b.perchY;
  const baseline = cell.baseline ?? cell.height;
  // Mirrored, the drawing reaches cell.width - ink.left past x; facing the edge, ink.right.
  const reach = Math.max(cell.width - ink.left, ink.right);
  const x = Math.min(Math.round(feetX - cell.width / 2), Math.floor(width - PERCH_MARGIN_PX - reach));
  return { x, lift: Math.round(height - (feetY - baseline) - cell.height) };
}

/** The gap between two boxes, 0 if they touch or overlap. */
export function boxGap(a: Box, b: Box): number {
  const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
  const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
  return Math.hypot(dx, dy);
}

/** The box around both, grown by `pad` on every side. */
export function unionBox(a: Box, b: Box, pad = 0): Box {
  const x = Math.min(a.x, b.x) - pad;
  const y = Math.min(a.y, b.y) - pad;
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) + pad - x, h: Math.max(a.y + a.h, b.y + b.h) + pad - y };
}

/** The drawing for this display: the smallest at least as sharp as the screen, else the sharpest. */
export function branchImageFor(dpr: number, images: BranchImage[] = BRANCH_IMAGES): BranchImage | null {
  const sorted = [...images].sort((a, b) => a.scale - b.scale);
  return sorted.find((i) => i.scale >= dpr - 0.25) ?? sorted[sorted.length - 1] ?? null;
}

/**
 * Where the cursor fades the bird: around it and the branch, only while it is
 * perched there and not picked up or flying. Null otherwise.
 */
export function fadeZone(s: BirdState, innerWidth: number, innerHeight: number): Box | null {
  if (!s.onBranch || s.mode === "drag" || s.mode === "flight") return null;
  return unionBox(birdBox(s, innerHeight), branchBox(innerWidth, innerHeight), FADE_NEAR_PX);
}

/** The boxes that take the cursor: the bird's first, except in the air, where it can't be caught. */
export function cursorBoxes(s: BirdState, innerHeight: number, extra: Box[]): Box[] {
  return s.mode === "flight" ? extra : [birdBox(s, innerHeight), ...extra];
}
