/**
 * Debug builds only (VITE_PARROT_DEBUG=1): a check on every drawn frame for a
 * sprite that is missing or incomplete, with the row, the frame and the cause.
 * The checks are pure; bird.ts gathers the facts and logs what fires.
 */

export const DEBUG = import.meta.env.VITE_PARROT_DEBUG === "1";

/** A turn squeezed thinner than this reads as the bird vanishing. */
export const SQUEEZE_BELOW = 0.3;
/** A lid wider than this share of the cell is not an eyelid. */
export const LID_MAX_SHARE = 0.25;
/** Drawing a row's image that takes longer than this had to decode it first: it wasn't ready when shown. */
export const NOT_DECODED_MS = 4;

/** What was on the element when a frame was drawn. */
export type FrameFacts = {
  row: string;
  frame: number;
  frames: number;
  /** The file this frame needs, and the file the element shows. */
  wantedFile: string;
  shownFile: string;
  hasImage: boolean;
  scaleX: number;
  lidShown: boolean;
  lidSize: number;
  cellWidth: number;
};

export type Issue = { cause: string; detail: string };

export function frameIssues(f: FrameFacts): Issue[] {
  const out: Issue[] = [];
  if (!f.hasImage) out.push({ cause: "no-image", detail: "the element has no image at all" });
  if (f.frame < 0 || f.frame >= f.frames) out.push({ cause: "frame-outside-row", detail: `frame ${f.frame} of ${f.frames}` });
  if (f.wantedFile !== f.shownFile) out.push({ cause: "previous-row-held", detail: `showing ${f.shownFile} while ${f.wantedFile} decodes` });
  if (Math.abs(f.scaleX) < SQUEEZE_BELOW) out.push({ cause: "turn-squeeze", detail: `scaleX ${f.scaleX.toFixed(2)}` });
  if (f.lidShown && f.lidSize > LID_MAX_SHARE * f.cellWidth) out.push({ cause: "lid-too-big", detail: `lid ${f.lidSize.toFixed(1)} px` });
  if (f.lidShown && f.wantedFile !== f.shownFile) out.push({ cause: "lid-over-other-row", detail: f.shownFile });
  return out;
}

/** One line per issue, and a line whenever the row changes, so a run shows what it went through. */
export function createFrameLog(write: (lines: string[]) => void, flushEveryMs = 500) {
  let buffer: string[] = [];
  let lastRow = "";
  const now = () => Date.now();
  const push = (line: string) => buffer.push(`${now()} page ${line}`);
  if (DEBUG) {
    setInterval(() => {
      if (buffer.length === 0) return;
      const lines = buffer;
      buffer = [];
      write(lines);
    }, flushEveryMs);
  }
  return {
    frame(f: FrameFacts, mode: string, x: number, lift: number) {
      if (f.row !== lastRow) {
        push(`row ${f.row} mode ${mode} at ${Math.round(x)},${Math.round(lift)}`);
        lastRow = f.row;
      }
      for (const issue of frameIssues(f)) push(`ISSUE ${issue.cause} row ${f.row} frame ${f.frame}: ${issue.detail}`);
    },
    note(text: string) {
      push(text);
    },
  };
}
