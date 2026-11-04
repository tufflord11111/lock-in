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
};

export const ROWS: SpriteRow[] = manifest.rows;
export const COLUMNS = manifest.columns;
export const DISPLAY_CELL = manifest.displayCell;
export const SHEET_ROWS = ROWS.length;

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
export function scaleFor(dpr: number) {
  return manifest.scales.find((s) => s.maxDpr !== null && dpr <= s.maxDpr) ?? manifest.scales[manifest.scales.length - 1];
}

/** background-position in CSS px. */
export function cellOffset(state: string, frame: number): { x: number; y: number } {
  return { x: -frame * DISPLAY_CELL, y: -ROWS.indexOf(rowOf(state)) * DISPLAY_CELL };
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
