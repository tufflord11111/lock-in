/**
 * A long, busy day with the real art, at 2x and 1x: the bird left to itself (walks, turns,
 * fidgets, flights to and from the branch) and handled (drags, drops on the branch and off it,
 * petting, talking), through sessions (fly up, sleep, full screen, wake, happy) and Bail outs,
 * many times over. Each step does what the overlay's draw() does: works out the frame and its
 * layers, and asks the sprite cache for them and for what may come next.
 *
 * The 1.3.0 freeze (sleep's grip refused once the cache was full of rows nothing wanted) would
 * have failed here: every frame's files must be held or on their way the moment it is wanted,
 * be ready within a decode, and the cache must never hold more than its 30 MB.
 */
import { describe, expect, it } from "vitest";
import { frameAt, frameRect, layerRect, rowOf, scaleFiles, scaleFor, type SheetScale } from "./animator";
import { lookFor, wantedFiles } from "./look";
import { frameIndex, initialState, perchFor, reduce, spriteState, type BirdEvent, type BirdState } from "./machine";
import { feetOnBranch } from "./perch";
import { SPRITE_BUDGET_BYTES, createSpriteCache } from "./spriteCache";

const STEP_MS = 33; // the loop's 30 Hz
const DECODE_MS = 60; // measured in the MSIX: every decode under 10 ms
const CYCLES = 12;
const WIDTH = 1440;
const HEIGHT = 900;
/**
 * The most any single state asks for, layers included, in 1.3.0 as shipped (look.test.ts prints
 * 20.9: an idle bird on the branch). 20.5 was before talk, preen and happy got their branch grips.
 */
const SHIPPED_PEAK_MIB = 20.94;
const MIB = 2 ** 20;

function soak(scale: SheetScale, seed: number) {
  let r = seed;
  const rand = () => (r = (r * 16807) % 2147483647) / 2147483647;
  const sizes = scaleFiles(scale);
  const bytesOf = (f: string) => sizes.get(f) ?? 0;

  // The cache over decodes that finish DECODE_MS after they start, all in parallel.
  const due: { at: number; file: string; resolve: (b: string) => void }[] = [];
  let t = 0;
  let pendingBytes = 0;
  const pending = new Set<string>();
  const cache = createSpriteCache<string>({
    decode: (file) =>
      new Promise<string>((resolve) => {
        pending.add(file);
        pendingBytes += bytesOf(file);
        due.push({ at: t + DECODE_MS, file, resolve });
      }),
    free: () => {},
    bytesOf,
    onReady: () => {},
    now: () => t,
  });

  let s: BirdState = initialState(0, WIDTH, false, false, rand(), undefined, HEIGHT);
  const events: Record<string, number> = {};
  const dispatch = (e: BirdEvent) => {
    events[e.type] = (events[e.type] ?? 0) + 1;
    s = reduce(s, e, t, rand());
  };

  const stats = { steps: 0, frames: 0, worstWaitMs: 0, refused: [] as string[], residentPeak: 0, wantedPeakVisible: 0, wantedPeakAt: "", overBudget: [] as string[], rows: new Set<string>(), modes: new Set<string>(), stuck: [] as string[] };
  let lastKey = "";
  let wantedSince = 0;
  let waitingFor = "";

  /** One loop step: the tick, then what draw() does. */
  const step = async () => {
    // Decodes that are done by now.
    for (const d of due.filter((d) => d.at <= t)) {
      due.splice(due.indexOf(d), 1);
      pending.delete(d.file);
      pendingBytes -= bytesOf(d.file);
      d.resolve(`bitmap:${d.file}`);
      await Promise.resolve();
      await Promise.resolve();
    }
    s = reduce(s, { type: "tick" }, t, rand());
    stats.steps++;
    stats.modes.add(s.mode);
    const name = spriteState(s, t);
    const frame = frameIndex(s, t, (row, elapsed) => frameAt(rowOf(row), elapsed));
    const rect = frameRect(scale, name, frame);
    const look = lookFor(name, frame, feetOnBranch(s, t));
    const under = look.under ? layerRect(scale, look.under, name, frame) : null;
    const over = look.over ? layerRect(scale, look.over, name, frame) : null;
    const needNow = [rect.file, ...(under ? [under.file] : []), ...(over ? [over.file] : [])];
    const wanted = [...new Set([...needNow, ...wantedFiles(s, t, scale)])];
    cache.want(wanted, needNow.length);
    stats.rows.add(name);

    // Every file this frame needs is held or on its way: never refused.
    for (const f of needNow) if (!cache.get(f) && !pending.has(f)) stats.refused.push(`${(t / 60000).toFixed(1)} min ${s.mode} ${name}@${frame}: ${f}`);
    // The cache, decodes under way included, never over budget.
    const resident = cache.bytes() + pendingBytes;
    stats.residentPeak = Math.max(stats.residentPeak, resident);
    if (resident > SPRITE_BUDGET_BYTES) stats.overBudget.push(`${(t / 60000).toFixed(1)} min: ${(resident / MIB).toFixed(2)} MiB`);
    if (!s.hidden) {
      const wantedBytes = wanted.reduce((n, f) => n + bytesOf(f), 0);
      if (wantedBytes > stats.wantedPeakVisible) {
        stats.wantedPeakVisible = wantedBytes;
        stats.wantedPeakAt = `${s.mode}${s.onBranch ? " on the branch" : ""}`;
      }
    }

    // How long each new frame waits for its files.
    const key = needNow.join("|") + `#${frame}`;
    if (key !== lastKey) {
      lastKey = key;
      stats.frames++;
      wantedSince = t;
      waitingFor = key;
    }
    if (waitingFor && needNow.every((f) => cache.get(f))) {
      stats.worstWaitMs = Math.max(stats.worstWaitMs, t - wantedSince);
      waitingFor = "";
    } else if (waitingFor && t - wantedSince > 5_000 && !stats.stuck.includes(waitingFor)) {
      stats.stuck.push(`${(t / 60000).toFixed(1)} min ${s.mode}: ${waitingFor}`);
    }
    t += STEP_MS;
  };
  const run = async (ms: number) => {
    for (const end = t + ms; t < end; ) await step();
  };

  // Handling, as the overlay sends it.
  const drag = async (to: { x: number; lift: number }) => {
    dispatch({ type: "dragStart" });
    const from = { x: s.x, lift: s.lift };
    for (let k = 1; k <= 20; k++) {
      dispatch({ type: "dragMove", x: from.x + ((to.x - from.x) * k) / 20, lift: Math.max(0, from.lift + ((to.lift - from.lift) * k) / 20), maxLift: HEIGHT - s.cell.height });
      await run(50);
    }
    dispatch({ type: "dragEnd" });
  };
  const pet = async (ms: number) => {
    for (let k = 0; k < ms / 100; k++) {
      dispatch({ type: "petRub" });
      await run(100);
    }
    dispatch({ type: "petEnd" });
  };
  const talk = async (ms: number) => {
    dispatch({ type: "talkStart" });
    await run(ms);
    dispatch({ type: "talkEnd" });
  };
  const somewhereOnTheGround = () => ({ x: Math.round(rand() * (WIDTH - s.cell.width)), lift: 0 });
  const inTheAir = () => ({ x: Math.round(rand() * (WIDTH - s.cell.width)), lift: Math.round(100 + rand() * 300) });
  /** Something the user does now and then: drag, drop on the branch, pet, talk, or nothing. */
  const handle = async () => {
    const pick = rand();
    if (pick < 0.2) await drag(somewhereOnTheGround());
    else if (pick < 0.32) await drag(inTheAir()); // let go mid-air: it falls
    else if (pick < 0.45) await drag(perchFor(s)); // dropped by the branch: it lands on it
    else if (pick < 0.65) await pet(1_000 + rand() * 4_000);
    else if (pick < 0.8) await talk(2_000 + rand() * 4_000);
    else if (pick < 0.88) {
      // A full-screen app for a while.
      dispatch({ type: "hidden", hidden: true });
      await run(5_000 + rand() * 20_000);
      dispatch({ type: "hidden", hidden: false });
    }
  };
  const awake = async (ms: number) => {
    for (const end = t + ms; t < end; ) {
      await run(10_000 + rand() * 50_000);
      await handle();
    }
  };

  return (async () => {
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      await awake(4 * 60_000);
      // A session: up to the branch, asleep; now and then picked up, hidden by a game, or talked to.
      dispatch({ type: "session", active: true });
      for (const end = t + 6 * 60_000; t < end; ) {
        await run(30_000 + rand() * 60_000);
        const pick = rand();
        if (pick < 0.25) await drag(somewhereOnTheGround());
        else if (pick < 0.45) await drag(perchFor(s));
        else if (pick < 0.7) {
          dispatch({ type: "hidden", hidden: true });
          await run(10_000 + rand() * 40_000);
          dispatch({ type: "hidden", hidden: false });
        } else if (pick < 0.8) await talk(3_000);
      }
      // Finished (wake, happy) or Bail out, every other time.
      const finished = cycle % 2 === 0;
      dispatch({ type: "session", active: false });
      dispatch({ type: "stoodDown", finished });
      await awake(3 * 60_000);
    }
    return { stats, events, minutes: t / 60_000 };
  })();
}

describe("a long day with the real art: every frame's files ready, within budget", () => {
  for (const dpr of [2, 1]) {
    it(`at ${dpr}x`, async () => {
      const scale = scaleFor(dpr);
      const { stats, events, minutes } = await soak(scale, 7 + dpr);
      console.log(
        `soak ${dpr}x: ${minutes.toFixed(0)} min, ${stats.steps} steps, ${stats.frames} frames, ${stats.rows.size} rows, modes ${[...stats.modes].sort().join(" ")}; ` +
          `events ${JSON.stringify(events)}; worst wait ${stats.worstWaitMs} ms; ` +
          `wanted peak while visible ${(stats.wantedPeakVisible / MIB).toFixed(2)} MiB (${stats.wantedPeakAt}); resident peak ${(stats.residentPeak / MIB).toFixed(2)} MiB`,
      );
      // It did the whole day: every mode, and every row the art has but the ones only debug tours show.
      for (const mode of ["idle", "walk", "peck", "preen", "mutter", "perch", "sleep", "wake", "happy", "talk", "drag", "fall", "flight", "pet"]) expect(stats.modes, mode).toContain(mode);
      expect(stats.rows).toContain("land");
      expect(stats.rows).toContain("takeoff");
      expect(events.stoodDown).toBe(CYCLES);

      expect(stats.refused, "a frame's file was refused").toEqual([]);
      expect(stats.stuck, "a frame never got its files").toEqual([]);
      expect(stats.worstWaitMs).toBeLessThanOrEqual(DECODE_MS + 2 * STEP_MS);
      expect(stats.overBudget, "the cache went over 30 MB").toEqual([]);
      expect(stats.residentPeak).toBeLessThanOrEqual(SPRITE_BUDGET_BYTES);
      expect(stats.wantedPeakVisible / MIB).toBeLessThanOrEqual(SHIPPED_PEAK_MIB);
    }, 120_000);
  }
});
