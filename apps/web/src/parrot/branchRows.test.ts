import { describe, expect, it } from "vitest";
import { SCALES } from "./animator";
import { beginFlight, initialState, isTurning, perchFor, reduce, spriteState, type BirdEvent, type BirdState } from "./machine";
import { BRANCH_DRAWINGS, BRANCH_ROWS, feetOnBranch, playsOnBranch } from "./perch";

const T0 = 1_000_000;
const WIDTH = 1440;
const HEIGHT = 900;

/** A small deterministic generator, so the walk is the same every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Everything that can happen to the bird, from outside or with time. */
function randomEvent(r: () => number, s: BirdState): BirdEvent {
  const events: BirdEvent[] = [
    { type: "tick" },
    { type: "tick" },
    { type: "tick" },
    { type: "session", active: r() < 0.5 },
    { type: "stoodDown", finished: r() < 0.5 },
    { type: "talkStart" },
    { type: "talkEnd" },
    { type: "petRub" },
    { type: "petRub" },
    { type: "petEnd" },
    { type: "hidden", hidden: r() < 0.2 },
    { type: "reducedMotion", reduced: r() < 0.3 },
    { type: "resize", width: WIDTH, height: HEIGHT },
    { type: "dragStart" },
    { type: "dragEnd" },
  ];
  // A drag ends near the perch half the time, so drops onto it are covered.
  if (s.mode === "drag" && r() < 0.5) return { type: "dragMove", x: WIDTH - 200, lift: HEIGHT * 0.4, maxLift: HEIGHT };
  return events[Math.floor(r() * events.length)];
}

/**
 * Walks the machine from the bird perched on a visit and asleep on the perch in a session, through
 * every kind of event at random intervals, and records each row drawn while its feet are on the
 * branch, and whether it was turning then.
 */
export function rowsPlayedOnBranch(walks = 300, steps = 400): { rows: Map<string, number>; turning: Map<string, number> } {
  const rows = new Map<string, number>();
  const turning = new Map<string, number>();
  for (let w = 0; w < walks; w++) {
    const r = rng(w + 1);
    const base = { ...initialState(T0, WIDTH, false, w % 3 === 0, r(), undefined, HEIGHT), branchDueAt: T0 };
    let s = w % 3 === 0 ? base : beginFlight(base, T0, perchFor(base), true);
    let now = T0;
    for (let i = 0; i < steps; i++) {
      // Mostly frame-sized steps, now and then a long wait, so stays, fidgets and blinks all come round.
      now += r() < 0.9 ? 15 + Math.floor(r() * 120) : Math.floor(r() * 90_000);
      s = reduce(s, randomEvent(r, s), now, r());
      for (const at of [now, now + 40, now + 90]) {
        if (!feetOnBranch(s, at)) continue;
        const row = spriteState(s, at);
        rows.set(row, (rows.get(row) ?? 0) + 1);
        if (isTurning(s, at)) turning.set(row, (turning.get(row) ?? 0) + 1);
      }
    }
  }
  return { rows, turning };
}

describe("the rows played on the branch", () => {
  const walk = rowsPlayedOnBranch();

  it("plays only rows the art fits to the branch: a front-grip cell at every scale and its own rowDy in every drawing", () => {
    const played = [...walk.rows.keys()].sort();
    console.log(`rows played on the branch: ${played.join(", ")}; allowed by the art: ${[...BRANCH_ROWS].sort().join(", ")}`);
    expect(played.length).toBeGreaterThan(3);
    for (const row of played) {
      for (const scale of SCALES) expect(scale.layers?.frontGrip?.rows[row], `${row}: grip cells at ${scale.cell.width} px`).toBeDefined();
      for (const d of BRANCH_DRAWINGS) expect(d.rowDy?.[row], `${row}: rowDy at ${d.scale}x`).toBeDefined();
      expect(playsOnBranch(row), row).toBe(true);
    }
    // Sleep, idle, petting, waking, landing and taking off all do come round.
    for (const row of ["idle", "sleep", "pet", "wake", "land", "takeoff"]) expect(played, row).toContain(row);
  });

  it("never plays talk, the preen, happy, peck or the mutter there, nor blink as a row: blink stays the lid layer", () => {
    for (const row of ["talk", "idle_preen", "happy", "peck", "idle_blink", "perch", "walk", "drag", "fly"]) {
      if (!playsOnBranch(row)) expect(walk.rows.has(row), row).toBe(false);
    }
  });

  it("never turns on the branch: dropped on it, it faces in at once; leaving, it turns in the air", () => {
    expect([...walk.turning.keys()]).toEqual([]);
  });

  it("allows exactly the rows with grip cells and rowDy in the art as shipped", () => {
    expect([...BRANCH_ROWS].sort()).toEqual(["idle", "land", "perch", "pet", "sleep", "takeoff", "wake"]);
  });
});
