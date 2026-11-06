/**
 * Puts the right image behind the bird. An image is applied only once it is
 * decoded, so a row the page has not shown yet never leaves the element
 * blank: the old frame holds for the few ms the decode takes. Each file is
 * decoded once. No DOM here: decoding and applying are passed in, so the
 * sequencing is testable.
 */
import type { FrameSource } from "./animator";

export type SheetSwap = {
  /** Show this frame: at once if its image is up, else after the decode. */
  show: (source: FrameSource) => void;
  /** Resolves once the first image is on the element. */
  ready: Promise<void>;
  /** The file on the element right now, "" before the first. */
  shown: () => string;
};

export function createSheetSwap(
  decode: (file: string) => Promise<void>,
  apply: (source: FrameSource) => void,
  /** Called after a decoded image goes up, so the caller can redraw the current frame. */
  onSwapped: () => void = () => {},
): SheetSwap {
  let shownFile = "";
  let wantedFile = "";
  const decoded = new Map<string, Promise<void>>();
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => (resolveReady = resolve));

  const decodeOnce = (file: string) => {
    let p = decoded.get(file);
    if (!p) {
      // A failed decode still swaps: a broken image is a bug to see, not a frozen bird.
      p = decode(file).catch(() => {});
      decoded.set(file, p);
    }
    return p;
  };

  // apply() runs while shown() is still the old file, so it can tell a new image from a moved frame.
  const put = (source: FrameSource) => {
    const first = shownFile === "";
    apply(source);
    shownFile = source.file;
    if (first) resolveReady();
  };

  return {
    show(source) {
      if (source.file === shownFile) {
        apply(source);
        return;
      }
      wantedFile = source.file;
      void decodeOnce(source.file).then(() => {
        // Superseded by a later row, or already up: nothing to do.
        if (wantedFile !== source.file || shownFile === source.file) return;
        put(source);
        onSwapped();
      });
    },
    ready,
    shown: () => shownFile,
  };
}
