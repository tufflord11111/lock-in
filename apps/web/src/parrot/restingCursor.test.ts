/**
 * A cursor resting on a sleeping, perched bird during a session changes nothing.
 *
 * While the cursor sits there the overlay gets: frame ticks, the branch fade (Rust's
 * parrot-fade, which only toggles classes and never reaches the machine), repeated
 * hit-box sends, the world re-sent with the same values, a same-size resize, and the
 * branch re-placed at the same height (the storage listener). None may wake it, move
 * it or change its row. A drag, which needs a left-button press, is the only input on
 * the bird that does.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { initialState, perchFor, reduce, spriteState, type BirdEvent, type BirdState } from "./machine";
import { BRANCH_DRAWINGS, branchOf, perchDy } from "./perch";

const W = 1920;
const H = 1040;
const T0 = 1_000_000;
const B = branchOf(BRANCH_DRAWINGS[0]);

function asleepOnThePerch(): { s: BirdState; now: number } {
  let s: BirdState = { ...initialState(T0, W, false, false, 0.3), height: H, branch: B };
  s = reduce(s, { type: "resize", width: W, height: H, branch: B }, T0, 0.3);
  s = reduce(s, { type: "session", active: true }, T0, 0.3);
  let now = T0;
  for (let i = 0; i < 600 && !(s.mode === "sleep" && s.onBranch); i++) {
    now += 33;
    s = reduce(s, { type: "tick" }, now, (i * 0.37) % 1);
  }
  return { s, now };
}

/** What the screen shows: the row, and where the cell is drawn (x, and lift less B's rowDy). */
const seen = (s: BirdState, now: number) => {
  const row = spriteState(s, now);
  return { mode: s.mode, row, onBranch: s.onBranch, x: s.x, y: s.lift - perchDy(s.branch, row) };
};

describe("a cursor resting on the sleeping, perched bird in a session", () => {
  it("falls asleep on the perch first (the setup)", () => {
    const { s } = asleepOnThePerch();
    expect(s.mode).toBe("sleep");
    expect(s.onBranch).toBe(true);
    expect(s.sessionActive).toBe(true);
    expect({ x: s.x, lift: s.lift }).toEqual(perchFor(s));
  });

  it("for 10 s: no row change, no position change, still asleep", () => {
    const { s: start, now: t } = asleepOnThePerch();
    const before = seen(start, t);
    // Everything the overlay hears while the cursor rests there, again and again.
    const resting: BirdEvent[] = [
      { type: "hidden", hidden: false },
      { type: "session", active: true },
      { type: "resize", width: W, height: H, branch: start.branch },
      { type: "branch", branch: start.branch },
    ];
    let s = start;
    let now = t;
    const rows = new Set<string>();
    const spots = new Set<string>();
    for (let i = 0; i < 300; i++) {
      now += 33;
      s = reduce(s, { type: "tick" }, now, (i * 0.61) % 1);
      if (i % 3 === 0) s = reduce(s, resting[(i / 3) % resting.length], now, (i * 0.13) % 1);
      const v = seen(s, now);
      rows.add(v.row);
      spots.add(`${v.x},${v.y}`);
    }
    expect(now - t).toBeGreaterThanOrEqual(9_900);
    expect([...rows]).toEqual([before.row]);
    expect([...spots]).toEqual([`${before.x},${before.y}`]);
    expect(seen(s, now)).toEqual(before);
  });

  it("the overlay sends the machine nothing on hover: only a press, a rub or a drag does", () => {
    const bird = readFileSync(new URL("./bird.ts", import.meta.url), "utf8");
    expect(bird).not.toMatch(/addEventListener\("(pointerenter|pointerover|mouseenter|mouseover)"/);
    // The fade never reaches the machine: it only toggles classes.
    expect(bird).toMatch(/setFaded: \(on\) => \{\s*faded = on;\s*showProps\(Date\.now\(\)\);\s*\}/);
    // Each pointermove handler returns at once without a press or a rub in progress.
    expect(bird).toMatch(/el\.addEventListener\("pointermove", \(e\) => \{\s*if \(!rub\) return;/);
    expect(bird).toMatch(/el\.addEventListener\("pointermove", \(e\) => \{\s*if \(!press\) return;/);
  });

  it("a drag ended by the branch is what plays the land row on the perch", () => {
    // The one machine path from asleep-on-the-perch to land-on-the-perch: a press, a
    // drag, and a drop near the branch. Each cycle needs a new left-button press.
    const { s: start, now: t } = asleepOnThePerch();
    let s = reduce(start, { type: "dragStart" }, t + 10, 0.5);
    expect(s.mode).toBe("drag");
    s = reduce(s, { type: "dragEnd" }, t + 20, 0.5);
    expect(s.mode).toBe("flight");
    expect(spriteState(s, t + 20)).toBe("land");
    expect(s.flight?.from).toEqual(s.flight?.to);
  });
});

