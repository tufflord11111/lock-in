/**
 * The 1.3.0 MSIX recording: with the cursor on the perched bird, the overlay held one
 * frame for up to 1.4 s at a time, so a landing never finished and the session's sleep
 * never came. The loop's "frames" plan waited on requestAnimationFrame alone; a webview
 * that stops delivering animation frames (a page it treats as hidden or covered) then
 * stopped the bird, not just its drawing. Timers still run there, at least once a second.
 *
 * The fallback timer exists only while drawing every frame, and goes with it.
 */
import { describe, expect, it, vi } from "vitest";
import { FRAME_FALLBACK_MS, createLoop, type LoopHost, type LoopPlan } from "./animator";

/**
 * A host with a clock. Animation frames come every `vsyncMs` (never, if null); timers
 * fire when due. Counts timer callbacks that ran while a frame was also pending, i.e.
 * the fallback firing instead of a frame.
 */
function clockHost(vsyncMs: number | null) {
  let now = 0;
  let id = 0;
  const rafs = new Map<number, (ts: number) => void>();
  const timers = new Map<number, { due: number; cb: () => void }>();
  let fallbackFires = 0;
  const host: LoopHost = {
    raf: (cb) => (rafs.set(++id, cb), id),
    cancelRaf: (i) => void rafs.delete(i),
    setTimer: (cb, ms) => (timers.set(++id, { due: now + ms, cb }), id),
    clearTimer: (i) => void timers.delete(i),
  };
  /** Runs the clock forward to `until`, firing frames and timers in time order. */
  const runTo = (until: number) => {
    let nextVsync = vsyncMs === null ? Infinity : Math.ceil((now + 0.001) / vsyncMs) * vsyncMs;
    for (;;) {
      const nextTimer = Math.min(Infinity, ...[...timers.values()].map((t) => t.due));
      const next = Math.min(nextTimer, nextVsync);
      if (next > until) break;
      now = next;
      if (next === nextTimer) {
        const [tid, t] = [...timers.entries()].find(([, t]) => t.due === next)!;
        timers.delete(tid);
        if (rafs.size > 0) fallbackFires++;
        t.cb();
      } else {
        const pending = [...rafs.values()];
        rafs.clear();
        for (const cb of pending) cb(now);
        nextVsync += vsyncMs as number;
      }
    }
    now = until;
  };
  return {
    host,
    rafs,
    timers,
    runTo,
    get fallbackFires() {
      return fallbackFires;
    },
  };
}

/** A landing (several frames), then asleep: what a session drop onto the perch plans. */
function landingThenAsleep(frames: number) {
  let left = frames;
  return vi.fn((): LoopPlan => (left-- > 0 ? { kind: "frames" } : { kind: "stop" }));
}

describe("the loop's fallback when animation frames stop", () => {
  it("a landing with no animation frames at all still finishes and reaches stop", () => {
    const f = clockHost(null);
    const step = landingThenAsleep(12); // ~0.4 s of land row at 30 fps
    const loop = createLoop(f.host, step);
    loop.poke();
    // No animation frame ever arrives: the fallback carries it, one step per FRAME_FALLBACK_MS.
    f.runTo(13 * FRAME_FALLBACK_MS + 1);
    expect(step).toHaveBeenCalledTimes(13);
    expect(loop.running).toBe(false);
  });

  it("however late the timers run (a hidden page clamps them to about once a second), it gets there", () => {
    // Only the order matters: each fallback step plans the next, until it stops.
    const f = clockHost(null);
    const step = landingThenAsleep(3);
    const loop = createLoop(f.host, step);
    loop.poke();
    f.runTo(10_000);
    expect(step).toHaveBeenCalledTimes(4);
    expect(loop.running).toBe(false);
  });

  it("leaves nothing scheduled once it stops: no frame request, no timer", () => {
    const f = clockHost(null);
    const loop = createLoop(f.host, landingThenAsleep(5));
    loop.poke();
    expect(f.timers.size).toBe(1);
    f.runTo(10_000);
    expect(loop.running).toBe(false);
    expect(f.rafs.size).toBe(0);
    expect(f.timers.size).toBe(0);
  });

  it("a stop() mid-landing (hidden, full screen, overlay closed) clears both", () => {
    const f = clockHost(16.67);
    const loop = createLoop(f.host, () => ({ kind: "frames" }));
    loop.poke();
    f.runTo(200);
    expect(f.rafs.size + f.timers.size).toBe(2);
    loop.stop();
    expect(f.rafs.size).toBe(0);
    expect(f.timers.size).toBe(0);
    f.runTo(5_000);
    expect(loop.running).toBe(false);
  });

  it("with frames arriving normally (60 Hz) the fallback never fires, and steps stay at 30 Hz", () => {
    const f = clockHost(1000 / 60);
    const step = vi.fn((): LoopPlan => ({ kind: "frames" }));
    const loop = createLoop(f.host, step);
    loop.poke();
    step.mockClear();
    f.runTo(2_000);
    expect(f.fallbackFires).toBe(0);
    expect(step.mock.calls.length).toBeGreaterThanOrEqual(58);
    expect(step.mock.calls.length).toBeLessThanOrEqual(61);
    // Exactly one of each pending at any time.
    expect(f.rafs.size).toBe(1);
    expect(f.timers.size).toBe(1);
    loop.stop();
  });

  it("a wait (idle, between fidgets) holds one timer and no fallback", () => {
    const f = clockHost(1000 / 60);
    const loop = createLoop(f.host, () => ({ kind: "wait", ms: 1000 }));
    loop.poke();
    expect(f.rafs.size).toBe(0);
    expect(f.timers.size).toBe(1);
    f.runTo(5_000);
    expect(f.rafs.size).toBe(0);
    expect(f.timers.size).toBe(1);
    expect(f.fallbackFires).toBe(0);
    loop.stop();
  });
});
