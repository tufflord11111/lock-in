/**
 * Sprite timing and the one animation loop. No DOM: the browser calls are
 * passed in, and frames come from elapsed time, never from counting callbacks.
 */
import manifest from "./sprites.manifest.json";

export type SpriteRow = {
  state: string;
  frames: number;
  fps: number;
  loop: boolean;
  from?: string;
  /** walk only: how far the sprite moves per frame, CSS px, so planted feet don't slide. Speed = stride x fps. */
  stride?: number;
  /** walk only: the frames with both feet down, where a walk may stop. Default: 0 and half way. */
  contact?: number[];
};

/** One frame's box on a sheet, in that sheet's px. Width and height are independent. */
export type Cell = { width: number; height: number };

/** The display cell, plus where the feet stand in it (CSS px from its top), when the art says. */
export type DisplayCell = Cell & { baseline?: number };

/** Where the art's eye is in one frame: centre and radius in the cell, and whether the art draws it open. */
export type Eye = { x: number; y: number; r: number; open: boolean };

/**
 * One sheet per display scale. Either one PNG of the whole sheet (`file`), or
 * one PNG per row (`rowFiles`, with `{state}` for the row's name), each cropped
 * to that row's frames, so the page decodes only the rows it shows. `eyes`
 * holds, per row and frame, the eye in this sheet's px, or null where the art
 * shows none.
 */
export type SheetScale = {
  maxDpr: number | null;
  cell: Cell;
  sheet: { width: number; height: number };
  file?: string;
  rowFiles?: string;
  eyes?: Record<string, (Eye | null)[]>;
};

/** A whole sheet that would decode to more than this must ship as row files. */
export const ROW_FILES_OVER_BYTES = 16 * 1024 * 1024;
export const decodedBytes = (size: { width: number; height: number }) => size.width * size.height * 4;

export const ROWS: SpriteRow[] = manifest.rows;
export const COLUMNS = manifest.columns;
/** The bird's box in CSS px, at every DPI. The 1× cell by convention. */
export const DISPLAY_CELL: DisplayCell = manifest.displayCell;
export const SCALES: SheetScale[] = manifest.scales;
/** The lid's fill, from the face patch around the eye. Absent for art with no eye data. */
export const LID_COLOUR: string | undefined = (manifest as { lidColour?: string }).lidColour;

/** The eye in this frame of this row, in display-cell CSS px, from this scale's own measurements. */
export function eyeAt(scale: SheetScale, state: string, frame: number): Eye | null {
  const eye = scale.eyes?.[state]?.[frame];
  if (!eye) return null;
  const k = scale.cell.width / DISPLAY_CELL.width;
  return { x: eye.x / k, y: eye.y / k, r: eye.r / k, open: eye.open };
}
export const SHEET_ROWS = ROWS.length;

/** A whole sheet's size for this cell: columns across, one row per state down. */
export const sheetSize = (cell: Cell) => ({ width: COLUMNS * cell.width, height: SHEET_ROWS * cell.height });

export function rowOf(state: string): SpriteRow {
  const row = ROWS.find((r) => r.state === state);
  if (!row) throw new Error(`No sprite row named ${state}`);
  return row;
}

export function frameAt(row: SpriteRow, elapsedMs: number): number {
  const n = Math.floor((Math.max(0, elapsedMs) * row.fps) / 1000);
  return row.loop ? n % row.frames : Math.min(n, row.frames - 1);
}

export const playedOnce = (row: SpriteRow, elapsedMs: number): boolean =>
  elapsedMs >= (row.frames * 1000) / row.fps;

/** The sheet for this display: ≤ 1.25 → 1×, ≤ 1.75 → 1.5×, else 2×. */
export function scaleFor(dpr: number): SheetScale {
  return SCALES.find((s) => s.maxDpr !== null && dpr <= s.maxDpr) ?? SCALES[SCALES.length - 1];
}

/** background-position for a frame on a whole sheet, in the cell's units (CSS px for DISPLAY_CELL). */
export function cellOffset(state: string, frame: number, cell: Cell = DISPLAY_CELL): { x: number; y: number } {
  return { x: -frame * cell.width, y: -ROWS.indexOf(rowOf(state)) * cell.height };
}

/** The image behind the bird for one frame, and how to place it, in CSS px. */
export type FrameSource = {
  file: string;
  /** background-size: the image's size in CSS px, so one sheet px is 1/scale CSS px. */
  size: { width: number; height: number };
  /** background-position. */
  position: { x: number; y: number };
};

export function frameSource(scale: SheetScale, state: string, frame: number): FrameSource {
  if (scale.rowFiles) {
    return {
      file: scale.rowFiles.replace("{state}", state),
      size: { width: rowOf(state).frames * DISPLAY_CELL.width, height: DISPLAY_CELL.height },
      position: { x: -frame * DISPLAY_CELL.width, y: 0 },
    };
  }
  if (!scale.file) throw new Error("A sheet scale needs file or rowFiles");
  return { file: scale.file, size: sheetSize(DISPLAY_CELL), position: cellOffset(state, frame) };
}

export const FRAME_BUDGET_MS = 1000 / 30;

/** What the loop does next: draw every frame, wake once later, or stop. */
export type LoopPlan = { kind: "frames" } | { kind: "wait"; ms: number } | { kind: "stop" };

export type LoopHost = {
  raf: (cb: (ts: number) => void) => number;
  cancelRaf: (id: number) => void;
  setTimer: (cb: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
};

/**
 * The single loop. step() runs at most 30 times a second while moving. With
 * nothing moving it holds no rAF at all: one timer if a frame is due later,
 * nothing if not, until poke().
 */
export function createLoop(host: LoopHost, step: () => LoopPlan) {
  let rafId: number | null = null;
  let timerId: number | null = null;
  let lastStepTs: number | null = null;

  const clear = () => {
    if (rafId !== null) host.cancelRaf(rafId);
    if (timerId !== null) host.clearTimer(timerId);
    rafId = null;
    timerId = null;
  };

  const apply = (plan: LoopPlan) => {
    if (plan.kind === "frames") {
      rafId = host.raf(onFrame);
    } else if (plan.kind === "wait") {
      lastStepTs = null;
      timerId = host.setTimer(() => {
        timerId = null;
        apply(step());
      }, plan.ms);
    } else {
      lastStepTs = null;
    }
  };

  const onFrame = (ts: number) => {
    rafId = null;
    // A small tolerance, so a 60 Hz display steps every second callback
    // instead of slipping to every third.
    if (lastStepTs !== null && ts - lastStepTs < FRAME_BUDGET_MS - 2) {
      rafId = host.raf(onFrame);
      return;
    }
    lastStepTs = ts;
    apply(step());
  };

  return {
    /** Something changed: re-plan now. */
    poke() {
      clear();
      apply(step());
    },
    stop() {
      clear();
      lastStepTs = null;
    },
    get running() {
      return rafId !== null || timerId !== null;
    },
  };
}
