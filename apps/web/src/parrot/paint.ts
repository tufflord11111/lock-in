/**
 * The bird canvas and the grip canvas show the same frame: the grip is drawn over the bird's
 * toes, row for row. They are painted off screen first and only then copied to the visible
 * canvases, so a failure part-way (a bitmap that won't draw) leaves both showing the last frame
 * that worked, never the bird on one row and the grip on another, or one of them blank.
 */
export type Paintable = Pick<CanvasRenderingContext2D, "clearRect" | "drawImage">;

/**
 * Paints one frame: `draw` paints the back buffers; if it and the copy both succeed, the visible
 * canvases show it and this returns true. If anything throws, the visible canvases are untouched
 * and this returns false (the error goes to `onError`).
 */
export function paintBoth(
  front: { bird: Paintable; grip: Paintable },
  back: { bird: Paintable; grip: Paintable; birdCanvas: CanvasImageSource; gripCanvas: CanvasImageSource },
  draw: (bird: Paintable, grip: Paintable) => void,
  size: { w: number; h: number } = { w: 1e5, h: 1e5 },
  onError: (err: unknown) => void = () => {},
): boolean {
  try {
    back.bird.clearRect(0, 0, size.w, size.h);
    back.grip.clearRect(0, 0, size.w, size.h);
    draw(back.bird, back.grip);
  } catch (err) {
    onError(err);
    return false;
  }
  // Both frames are ready: show them together. A canvas-to-canvas copy of a same-size canvas
  // doesn't fail in practice; if it ever does, the next frame paints again.
  try {
    front.bird.clearRect(0, 0, size.w, size.h);
    front.bird.drawImage(back.birdCanvas, 0, 0);
    front.grip.clearRect(0, 0, size.w, size.h);
    front.grip.drawImage(back.gripCanvas, 0, 0);
  } catch (err) {
    onError(err);
    return false;
  }
  return true;
}
