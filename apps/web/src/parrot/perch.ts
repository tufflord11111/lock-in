/**
 * The branch at the right edge and the perch on it. Pure geometry in CSS px,
 * measured from the overlay's top-left; the overlay is the bird's monitor's
 * work area, so the branch is on that monitor only.
 */
import manifest from "./sprites.manifest.json";
import { SCALES, type DisplayCell } from "./animator";
import { birdBox, type Box } from "./layout";
import type { BirdState } from "./machine";

/** A rectangle on the branch, from its top-left. */
export type Rect = { x: number; y: number; w: number; h: number };

/**
 * The branch in CSS px, from its top-left: its size, the perch point (where
 * the bird's feet go), where the feet are in the bird's cell as it is drawn
 * perched, mirrored (feetX; the cell's middle if the art doesn't say), and the
 * contact shadow's place on it (meta.branch.shadow). The front grip that
 * wraps the bark round the toes is a layer of the bird's sheet, not of this.
 */
export type Branch = {
  width: number;
  height: number;
  perchX: number;
  perchY: number;
  feetX?: number;
  /** The contact shadow on the bark, drawn after the branch and before the bird. */
  shadow?: Rect;
  /** The trunk's dark top outline's thickness, meta.branch.outlinePx. */
  outlinePx?: number;
  sinkPx?: number;
  /** The drawing's scale: its px per CSS px. Positions on it are kept on whole device px. */
  scale?: number;
  /** B's rule (meta.branch): the perched (mirrored) cell's top-left from the branch's, CSS px. */
  cell?: { x: number; y: number };
  /** B's rule: how much lower each row sits perched, CSS px; 0 for a row not listed. */
  rowDy?: Record<string, number>;
  /**
   * Where the perch point sits, as a fraction of the work area's height
   * (DEFAULT_BRANCH_AT when not set): the user moves it with a Ctrl-drag, and
   * it is kept on this PC (loadBranchAt), so it survives restarts and new resolutions.
   */
  at?: number;
};

/** One drawing of the branch per sheet scale, in that drawing's px, as the manifest has it. */
export type BranchDrawing = {
  scale: number;
  file: string;
  width: number;
  height: number;
  perchX?: number;
  perchY?: number;
  feetX?: number;
  /** meta.branch.shadow: its image, and where it goes on the branch. */
  shadow?: Rect & { file: string };
  /** meta.branch.outlinePx: how thick the trunk's top outline is. */
  outlinePx?: number;
  /** meta.branch.drawOrder, as the art gives it: branch, shadow, bird, frontGrip. */
  drawOrder?: string[];
  /** How far below the trunk's top line, under both feet, the feet sink (meta.branch.sinkPx). */
  sinkPx?: number;
  /** The mirrored cell's top-left from the branch's, this drawing's px: perchX - birdFeetX, round(perchY - baseline). */
  cell?: { x: number; y: number };
  /** meta.branch.rowDy, this drawing's px. */
  rowDy?: Record<string, number>;
};

const m = manifest as { branches?: BranchDrawing[]; ink?: Ink; displayCell: { width: number } };

/** How far the drawing reaches across the display cell in any frame: [left, right), CSS px from its left. */
export type Ink = { left: number; right: number };
export const INK: Ink = m.ink ?? { left: 0, right: m.displayCell.width };

/** The branch is on the right edge, so on it the bird faces left, into the screen. */
export const INTO_SCREEN = -1 as const;
/** Kept between the bird's drawing and the screen's right edge. */
export const PERCH_MARGIN_PX = 2;

export const BRANCH_DRAWINGS: BranchDrawing[] = [...(m.branches ?? [])].sort((a, b) => a.scale - b.scale);

/**
 * A drawing's branch in CSS px: its own px over its scale, so the bird stands
 * where that drawing has its perch. Without meta.branch, a guessed perch: 45%
 * in from the free (left) end, 55% of the way down.
 */
export function branchOf(d: BranchDrawing | undefined): Branch {
  if (!d) return { width: 96, height: 64, perchX: 43, perchY: 35 };
  const k = d.scale;
  const width = d.width / k;
  const height = d.height / k;
  return {
    width,
    height,
    perchX: d.perchX !== undefined ? d.perchX / k : Math.round(width * 0.45),
    perchY: d.perchY !== undefined ? d.perchY / k : Math.round(height * 0.55),
    ...(d.feetX !== undefined ? { feetX: d.feetX / k } : {}),
    ...(d.shadow ? { shadow: { x: d.shadow.x / k, y: d.shadow.y / k, w: d.shadow.w / k, h: d.shadow.h / k } } : {}),
    ...(d.outlinePx !== undefined ? { outlinePx: d.outlinePx / k } : {}),
    ...(d.sinkPx !== undefined ? { sinkPx: d.sinkPx / k } : {}),
    scale: k,
    ...(d.cell ? { cell: { x: d.cell.x / k, y: d.cell.y / k } } : {}),
    ...(d.rowDy ? { rowDy: Object.fromEntries(Object.entries(d.rowDy).map(([row, dy]) => [row, dy / k])) } : {}),
  };
}

/** The drawing for this display: the smallest at least as sharp as the screen, else the sharpest. */
export function branchDrawingFor(dpr: number, drawings: BranchDrawing[] = BRANCH_DRAWINGS): BranchDrawing | undefined {
  return drawings.find((d) => d.scale >= dpr - 0.25) ?? drawings[drawings.length - 1];
}

/**
 * The rows the bird may play with its feet on the branch: those the art gives
 * a front-grip cell (meta.layers.frontGrip) at every scale and its own rowDy
 * (meta.branch.rowDy) in every drawing. Any other row would stand there with
 * its toes bare over the bark, or at the wrong height, so the machine never
 * plays it there (parrot-art da9d6b2: idle, perch, sleep, pet, wake, land,
 * takeoff).
 */
export const BRANCH_ROWS: ReadonlySet<string> = new Set(
  Object.keys(SCALES[0]?.layers?.frontGrip?.rows ?? {}).filter(
    (row) =>
      SCALES.every((s) => s.layers?.frontGrip?.rows[row] !== undefined) &&
      m.branches !== undefined &&
      m.branches.length > 0 &&
      m.branches.every((d) => d.rowDy?.[row] !== undefined),
  ),
);
export const playsOnBranch = (row: string): boolean => BRANCH_ROWS.has(row);

/** The 1x branch: the machine's default until the overlay says which drawing it shows. */
export const BRANCH: Branch = branchOf(BRANCH_DRAWINGS[0]);

/**
 * The perch point sits this far down the work area by default: low on the right
 * edge, where it covers less of what is open (it was 0.55). The work area stops at
 * the taskbar, so it is always clear of it.
 */
export const DEFAULT_BRANCH_AT = 0.75;
/** A drop this close to the branch lands on the perch. */
export const DROP_ON_PERCH_PX = 60;
/** A cursor this close to the branch fades it, its shadow and the front grip (never the bird). */
export const FADE_NEAR_PX = 120;

/**
 * How high the branch's top may go: low enough that a bird perched on it, in its
 * highest row (B's rule: the mirrored cell's top, less any row's negative rowDy),
 * stays inside the work area. 0 when the art doesn't say where the cell goes.
 */
export function branchTopMin(b: Branch = BRANCH): number {
  if (!b.cell) return 0;
  const up = Math.min(0, ...Object.values(b.rowDy ?? {}));
  return Math.max(0, -(b.cell.y + up));
}

/**
 * The branch's top, CSS px: its perch point `at` (b.at, else DEFAULT_BRANCH_AT)
 * of the way down, clamped inside the work area (the whole branch, and a bird
 * perched on it), on a whole device px of its drawing's scale so the bird placed
 * from it by B's rule is too.
 */
export function branchTop(height: number, b: Branch = BRANCH): number {
  const k = b.scale ?? 1;
  const at = b.at ?? DEFAULT_BRANCH_AT;
  const max = height - b.height;
  const min = Math.min(branchTopMin(b), max);
  const y = Math.min(max, Math.max(min, height * at - b.perchY));
  return Math.round(y * k) / k;
}

/** The fraction that puts the branch's top at `top` (clamped as branchTop does): what a drag saves. */
export function branchAtFor(top: number, height: number, b: Branch = BRANCH): number {
  if (height <= 0) return DEFAULT_BRANCH_AT;
  const placed = branchTop(height, { ...b, at: (top + b.perchY) / height });
  return (placed + b.perchY) / height;
}

/** The branch's box: flush with the right edge, its perch point `at` of the way down (branchTop). */
export function branchBox(width: number, height: number, b: Branch = BRANCH): Box {
  return { x: width - b.width, y: branchTop(height, b), w: b.width, h: b.height };
}

/** Where this PC keeps the branch's height (a local setting: not the account's). */
export const BRANCH_AT_KEY = "parrot.branchAt";

/** The saved fraction, if there is a sensible one; else undefined (the default). */
export function loadBranchAt(storage: Pick<Storage, "getItem"> | null | undefined): number | undefined {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(BRANCH_AT_KEY) ?? null;
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;
  const at = Number(raw);
  return Number.isFinite(at) && at > 0 && at < 1 ? at : undefined;
}

/** Keeps the fraction on this PC; undefined forgets it (back to the default). */
export function saveBranchAt(storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined, at: number | undefined): void {
  try {
    if (at === undefined) storage?.removeItem(BRANCH_AT_KEY);
    else storage?.setItem(BRANCH_AT_KEY, String(Math.round(at * 10_000) / 10_000));
  } catch {
    // Storage unavailable: the branch stays where it is for this run.
  }
}

/** B's rule: how much lower this row sits perched, CSS px (0 for a row meta.branch.rowDy doesn't list). */
export const perchDy = (b: Branch, row: string): number => b.rowDy?.[row] ?? 0;

/**
 * Where the bird stands on the perch: x and lift, as the machine keeps them.
 * Its feet on the perch point, facing into the screen: the cell is mirrored
 * about its middle, so feet that are feetX from its left facing right are
 * width - feetX from it facing in. Moved in along the branch only if it takes
 * that to keep the whole drawing on the screen, facing in as it perches or
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
  // Mirrored, the drawing reaches cell.width - ink.left past x; facing the edge, ink.right.
  const reach = Math.max(cell.width - ink.left, ink.right);
  if (b.cell) {
    // B's rule, measured for the mirrored bird: the cell's top-left straight from the branch's, on
    // whole device px (rowDy is added per row as it is drawn: perchDy).
    const k = b.scale ?? 1;
    const x = Math.min(box.x + b.cell.x, Math.floor((width - PERCH_MARGIN_PX - reach) * k) / k);
    return { x, lift: height - (box.y + b.cell.y) - cell.height };
  }
  const feetX = box.x + b.perchX;
  const feetY = box.y + b.perchY;
  const baseline = cell.baseline ?? cell.height;
  const feetInCell = cell.width - (b.feetX ?? cell.width / 2);
  const x = Math.min(Math.round(feetX - feetInCell), Math.floor(width - PERCH_MARGIN_PX - reach));
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

/** The branch shadow's box on the screen, if the branch has one. */
export function shadowBox(width: number, height: number, b: Branch = BRANCH): Box | null {
  if (!b.shadow) return null;
  const box = branchBox(width, height, b);
  return { x: box.x + b.shadow.x, y: box.y + b.shadow.y, w: b.shadow.w, h: b.shadow.h };
}

/** Perched: on the branch and not picked up or flying. */
export const isPerched = (s: BirdState): boolean => s.onBranch && s.mode !== "drag" && s.mode !== "flight";

/**
 * The branch is only there when it is needed: from the moment the bird sets
 * off for it (a visit, a session, a drop by it) while it is there, and until
 * it has left (the flight down past its takeoff). The overlay fades it in and
 * out around this.
 */
export function branchShown(s: BirdState, now: number): boolean {
  if (s.onBranch) return true;
  const f = s.flight;
  if (s.mode !== "flight" || !f) return false;
  return f.toBranch || (f.fromBranch && now < f.flyAt);
}

/**
 * Whether its feet are on the branch: perched, asleep there, landing (the land
 * row), taking off (the takeoff row). Not in the air. Then the branch shadow
 * is under it and the front grip over its toes, and B's rowDy places each row.
 */
export function feetOnBranch(s: BirdState, now: number): boolean {
  if (s.onBranch && s.mode !== "drag") return true;
  const f = s.flight;
  if (s.mode !== "flight" || !f) return false;
  return (f.toBranch && now >= f.landRowAt) || (f.fromBranch && now < f.flyAt);
}

/**
 * Where a cursor fades things out of its way: 120 px round the branch, whenever
 * it is shown. The branch, its shadow (inside its box) and the front grip fade
 * together. Never the bird: perched or not it stays solid, and takes the cursor
 * on its own box at once, so it can always be grabbed or petted.
 */
export function fadeZone(s: BirdState, innerWidth: number, innerHeight: number, now: number): Box | null {
  if (!branchShown(s, now)) return null;
  const b = branchBox(innerWidth, innerHeight, s.branch);
  return { x: b.x - FADE_NEAR_PX, y: b.y - FADE_NEAR_PX, w: b.w + 2 * FADE_NEAR_PX, h: b.h + 2 * FADE_NEAR_PX };
}

/**
 * The boxes that take the cursor: the bird's first, except in the air, where it
 * can't be caught. Never the branch or its shadow; the front grip lies inside
 * the bird's box and takes nothing of its own, so a grab goes through it.
 */
export function cursorBoxes(s: BirdState, innerHeight: number, extra: Box[], drawn?: Box | null): Box[] {
  // `drawn`: the bird's visible pixels (layout.ts inkBox), when the overlay knows them; else the cell.
  return s.mode === "flight" ? extra : [drawn ?? birdBox(s, innerHeight), ...extra];
}
