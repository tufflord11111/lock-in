import { describe, expect, it } from "vitest";
import { ROWS } from "./animator";
import { initialState, nextRows, reduce, spriteState, type BirdEvent, type BirdState } from "./machine";

/**
 * The v0.2 stand-in rows. They ship in the sheet (its layout keeps every row's
 * place) but nothing in the app may show them, or decode them ahead: they are
 * placeholders the art hasn't replaced.
 */
const STAND_INS = ["sad", "yawn", "droopy_idle"];

const T0 = 1_000_000;
const WIDTH = 1440;
const HEIGHT = 900;

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

/** Everything that can happen to the bird, on the ground or on the branch. */
function randomEvent(r: () => number, s: BirdState): BirdEvent {
  if (s.mode === "drag" && r() < 0.6) {
    // Carried anywhere on the screen, sometimes right by the perch.
    return r() < 0.3
      ? { type: "dragMove", x: WIDTH - 200, lift: HEIGHT * 0.4, maxLift: HEIGHT }
      : { type: "dragMove", x: Math.floor(r() * WIDTH), lift: Math.floor(r() * HEIGHT * 0.8), maxLift: HEIGHT };
  }
  const events: BirdEvent[] = [
    { type: "tick" },
    { type: "tick" },
    { type: "tick" },
    { type: "tick" },
    { type: "session", active: r() < 0.5 },
    { type: "stoodDown", finished: r() < 0.5 },
    { type: "talkStart" },
    { type: "talkEnd" },
    { type: "petRub" },
    { type: "petEnd" },
    { type: "hidden", hidden: r() < 0.2 },
    { type: "reducedMotion", reduced: r() < 0.3 },
    { type: "resize", width: WIDTH - Math.floor(r() * 400), height: HEIGHT - Math.floor(r() * 200) },
    { type: "dragStart" },
    { type: "dragEnd" },
  ];
  return events[Math.floor(r() * events.length)];
}

/** Every row drawn, and every row loaded ahead, over many long random walks from the ground and from a session. */
function rowsEverUsed(walks = 200, steps = 600): { drawn: Set<string>; ahead: Set<string> } {
  const drawn = new Set<string>();
  const ahead = new Set<string>();
  for (let w = 0; w < walks; w++) {
    const r = rng(1000 + w);
    // Branch visits come due early on some walks, never on others.
    let s: BirdState = { ...initialState(T0, WIDTH, w % 5 === 0, w % 4 === 0, r(), undefined, HEIGHT), branchDueAt: w % 2 ? T0 : Infinity };
    let now = T0;
    for (let i = 0; i < steps; i++) {
      now += r() < 0.9 ? 15 + Math.floor(r() * 150) : Math.floor(r() * 120_000);
      s = reduce(s, randomEvent(r, s), now, r());
      for (const at of [now, now + 50]) {
        drawn.add(spriteState(s, at));
        for (const row of nextRows(s, at)) ahead.add(row);
      }
    }
  }
  return { drawn, ahead };
}

describe("the v0.2 stand-in rows (sad, yawn, droopy_idle)", () => {
  const { drawn, ahead } = rowsEverUsed();

  it("are still in the sheet, so every other row keeps its place", () => {
    for (const row of STAND_INS) expect(ROWS.some((r) => r.state === row), row).toBe(true);
  });

  it("are never drawn, on the ground, on the branch, carried, falling or flying", () => {
    console.log(`rows drawn on the walk: ${[...drawn].sort().join(", ")}`);
    // The walk reaches every kind of row the app does use, so it isn't simply missing them.
    for (const row of ["idle", "walk", "peck", "idle_preen", "talk", "perch", "sleep", "wake", "happy", "pet", "drag", "takeoff", "fly", "land"]) {
      expect(drawn, row).toContain(row);
    }
    for (const row of STAND_INS) expect(drawn.has(row), row).toBe(false);
  });

  it("are never decoded ahead either", () => {
    for (const row of STAND_INS) expect(ahead.has(row), row).toBe(false);
  });
});
