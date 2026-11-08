/**
 * The branch at the right edge and the perch on it. Pure geometry in CSS px,
 * measured from the overlay's top-left; the overlay is the bird's monitor's
 * work area, so the branch is on that monitor only.
 */
import manifest from "./sprites.manifest.json";
import type { DisplayCell } from "./animator";
import type { Box } from "./layout";

/** The branch's size and its perch point (where the bird's feet go), CSS px from its top-left. */
export type Branch = { width: number; height: number; perchX: number; perchY: number };

/** One drawing of the branch per sheet scale, in that drawing's px. */
export type BranchImage = { scale: number; file: string; width: number; height: number };

type Prop = { name: string; scale: number; file: string; width: number; height: number };
const m = manifest as { props?: Prop[]; branch?: Branch };

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

/** Where the bird stands on the perch: x and lift, as the machine keeps them. Feet on the perch point, centred. */
export function perchSpot(width: number, height: number, cell: DisplayCell, b: Branch = BRANCH): { x: number; lift: number } {
  const box = branchBox(width, height, b);
  const feetX = box.x + b.perchX;
  const feetY = box.y + b.perchY;
  const baseline = cell.baseline ?? cell.height;
  return { x: Math.round(feetX - cell.width / 2), lift: Math.round(height - (feetY - baseline) - cell.height) };
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
