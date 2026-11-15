/**
 * One bad frame must never stop the bird or leave it half-drawn.
 *
 * - The loop: a step() that throws (a draw error, a bad bitmap) used to propagate out of the
 *   timer or animation-frame callback, and the loop never planned again: the bird froze for good.
 * - The paint: the bird canvas and the grip canvas were cleared and drawn one after the other on
 *   screen, so a throw between them left the bird on one frame and the grip on another, or blank.
 *   Now both are drawn off screen first and only shown when both succeeded.
 */
import { describe, expect, it, vi } from "vitest";
import { ERROR_RETRY_MS, createLoop, type LoopHost, type LoopPlan } from "./animator";
import { paintBoth, type Paintable } from "./paint";

function timersHost() {
  const timers = new Map<number, { cb: () => void; ms: number }>();
  const rafs = new Map<number, (ts: number) => void>();
  let id = 0;
  const host: LoopHost = {
    raf: (cb) => (rafs.set(++id, cb), id),
    cancelRaf: (i) => void rafs.delete(i),
    setTimer: (cb, ms) => (timers.set(++id, { cb, ms }), id),
    clearTimer: (i) => void timers.delete(i),
  };
  const fire = () => {
    const pending = [...timers.values()];
    timers.clear();
    for (const t of pending) t.cb();
  };
  return { host, timers, rafs, fire };
}

describe("the loop survives a step that throws", () => {
  it("a throw is reported, and the loop tries again shortly instead of stopping", () => {
    const f = timersHost();
    let calls = 0;
    const step = vi.fn((): LoopPlan => {
      calls++;
      if (calls === 2) throw new Error("drawImage: the bitmap is closed");
      return { kind: "wait", ms: 100 };
    });
    const onError = vi.fn();
    const loop = createLoop(f.host, step, onError);
    loop.poke();
    expect(() => f.fire()).not.toThrow(); // the throwing step
    expect(onError).toHaveBeenCalledTimes(1);
    expect(loop.running).toBe(true);
    expect([...f.timers.values()][0].ms).toBe(ERROR_RETRY_MS);
    f.fire();
    expect(step).toHaveBeenCalledTimes(3);
    expect(loop.running).toBe(true);
  });

  it("the same from an animation frame and from a poke", () => {
    const f = timersHost();
    const onError = vi.fn();
    const loop = createLoop(f.host, () => { throw new Error("boom"); }, onError);
    expect(() => loop.poke()).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(loop.running).toBe(true);
    loop.stop();
    expect(loop.running).toBe(false);
  });
});

/** A context that records what was done to it, and can be made to throw on a given draw. */
function fakeCtx(name: string, log: string[], throwOnDraw = -1): Paintable {
  let draws = 0;
  return {
    clearRect: () => void log.push(`${name}.clear`),
    drawImage: (src: unknown) => {
      if (draws++ === throwOnDraw) throw new Error(`${name} draw failed`);
      log.push(`${name}.draw(${typeof src === "string" ? src : "back"})`);
    },
  } as unknown as Paintable;
}

describe("paintBoth: the bird and the grip go up together or not at all", () => {
  it("draws both off screen, then shows both", () => {
    const log: string[] = [];
    const front = { bird: fakeCtx("bird", log), grip: fakeCtx("grip", log) };
    const back = { bird: fakeCtx("backBird", log), grip: fakeCtx("backGrip", log), birdCanvas: "B" as unknown as CanvasImageSource, gripCanvas: "G" as unknown as CanvasImageSource };
    const ok = paintBoth(front, back, (b, g) => {
      b.drawImage("sleep" as unknown as CanvasImageSource, 0, 0);
      g.drawImage("sleepGrip" as unknown as CanvasImageSource, 0, 0);
    });
    expect(ok).toBe(true);
    expect(log).toEqual([
      "backBird.clear", "backGrip.clear", "backBird.draw(sleep)", "backGrip.draw(sleepGrip)",
      "bird.clear", "bird.draw(B)", "grip.clear", "grip.draw(G)",
    ]);
  });

  it("a throw part-way leaves both visible canvases exactly as they were", () => {
    const log: string[] = [];
    const front = { bird: fakeCtx("bird", log), grip: fakeCtx("grip", log) };
    const back = { bird: fakeCtx("backBird", log), grip: fakeCtx("backGrip", log, 0), birdCanvas: "B" as unknown as CanvasImageSource, gripCanvas: "G" as unknown as CanvasImageSource };
    const ok = paintBoth(front, back, (b, g) => {
      b.drawImage("sleep" as unknown as CanvasImageSource, 0, 0);
      g.drawImage("sleepGrip" as unknown as CanvasImageSource, 0, 0); // throws
    });
    expect(ok).toBe(false);
    expect(log.filter((l) => l.startsWith("bird.") || l.startsWith("grip."))).toEqual([]);
  });
});
