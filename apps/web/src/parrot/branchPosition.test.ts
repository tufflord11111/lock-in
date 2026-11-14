import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DISPLAY_CELL } from "./animator";
import { birdBox } from "./layout";
import { beginFlight, initialState, perchFor, reduce, type BirdEvent, type BirdState } from "./machine";
import {
  BRANCH_AT_KEY,
  BRANCH_DRAWINGS,
  DEFAULT_BRANCH_AT,
  branchAtFor,
  branchBox,
  branchOf,
  branchTop,
  branchTopMin,
  loadBranchAt,
  perchSpot,
  saveBranchAt,
  type Branch,
} from "./perch";

const W = 1440;
const H = 900;
const T0 = 1_000_000;
const DRAWINGS = BRANCH_DRAWINGS.map(branchOf);
const B: Branch = DRAWINGS[0];
const go = (s: BirdState, e: BirdEvent, now = T0) => reduce(s, e, now, 0.5);
const ground = (): BirdState => ({ ...initialState(T0, W, false, false, 0), branch: B, branchDueAt: Infinity, restUntil: T0 + 60_000, nextAt: T0 + 60_000 });
const perched = (): BirdState => {
  const up = beginFlight(ground(), T0, perchFor(ground()), true);
  return go(up, { type: "tick" }, up.flight!.endAt);
};

/** A Storage stand-in. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

describe("the branch's height on the right edge", () => {
  it("sits 75% of the way down the work area by default, flush right, clear of the taskbar", () => {
    expect(DEFAULT_BRANCH_AT).toBe(0.75);
    for (const b of DRAWINGS) {
      for (const h of [720, 900, 1040, 1400]) {
        const box = branchBox(W, h, b);
        expect(box.x + box.w).toBe(W);
        // The perch point 75% down, to the drawing's device px.
        expect(Math.abs(box.y + b.perchY - h * 0.75)).toBeLessThanOrEqual(1 / (b.scale ?? 1));
        // The overlay is the work area, which stops at the taskbar: the whole branch is above it.
        expect(box.y + box.h).toBeLessThanOrEqual(h);
      }
    }
  });

  it("is clamped inside the work area: never below its bottom, and never so high a perched bird leaves the top", () => {
    for (const b of DRAWINGS) {
      for (const at of [-1, 0, 0.01, 0.5, 0.99, 1, 2]) {
        const placed = { ...b, at };
        const box = branchBox(W, H, placed);
        expect(box.y + box.h).toBeLessThanOrEqual(H);
        expect(box.y).toBeGreaterThanOrEqual(Math.min(branchTopMin(b), H - b.height) - 1e-9);
        // The perched bird, in any row (rowDy included), stays on the screen.
        const spot = perchSpot(W, H, DISPLAY_CELL, placed);
        const top = birdBox({ ...spot, cell: DISPLAY_CELL }, H).y;
        const highest = Math.min(0, ...Object.values(b.rowDy ?? {}));
        expect(top + highest).toBeGreaterThanOrEqual(-1e-9);
      }
      // The highest and lowest it can go, and a drag past them stops there.
      expect(branchTop(H, { ...b, at: 0 })).toBeCloseTo(branchTopMin(b), 6);
      expect(branchTop(H, { ...b, at: 1 })).toBeCloseTo(H - b.height, 6);
      expect(branchAtFor(-500, H, b)).toBeCloseTo((branchTopMin(b) + b.perchY) / H, 2);
      expect(branchAtFor(H + 500, H, b)).toBeCloseTo((H - b.height + b.perchY) / H, 2);
    }
  });

  it("moves only up and down: its x never changes", () => {
    for (const at of [0.2, 0.5, 0.9]) expect(branchBox(W, H, { ...B, at }).x).toBe(W - B.width);
  });
});

describe("the branch's height is kept on this PC as a fraction of the work area's height", () => {
  it("saves and loads the fraction, and forgets it on reset", () => {
    const store = memoryStorage();
    expect(loadBranchAt(store)).toBeUndefined();
    saveBranchAt(store, 0.4123456);
    expect(store.getItem(BRANCH_AT_KEY)).toBe("0.4123");
    expect(loadBranchAt(store)).toBe(0.4123);
    saveBranchAt(store, undefined);
    expect(store.getItem(BRANCH_AT_KEY)).toBeNull();
    expect(loadBranchAt(store)).toBeUndefined();
  });

  it("ignores anything that isn't a fraction, and storage that throws", () => {
    const store = memoryStorage();
    for (const bad of ["", "abc", "NaN", "0", "1", "-0.2", "1.5", "Infinity"]) {
      store.setItem(BRANCH_AT_KEY, bad);
      expect(loadBranchAt(store)).toBeUndefined();
    }
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadBranchAt(throwing)).toBeUndefined();
    expect(() => saveBranchAt(throwing, 0.5)).not.toThrow();
    expect(loadBranchAt(null)).toBeUndefined();
  });

  it("survives a restart and a new resolution: the same fraction of whatever height the work area has", () => {
    const store = memoryStorage();
    const at = branchAtFor(300, 900, B);
    saveBranchAt(store, at);
    // A restart reads it back; on a taller work area it sits the same fraction down.
    const again = loadBranchAt(store)!;
    for (const h of [900, 1200, 1600]) {
      const box = branchBox(W, h, { ...B, at: again });
      expect(Math.abs((box.y + B.perchY) / h - again)).toBeLessThan(0.002);
    }
  });
});

describe("moving the branch moves a perched bird with it, and only the branch", () => {
  it("the perched bird rides the branch to its new height, still on the perch", () => {
    const s = perched();
    expect(s.onBranch).toBe(true);
    for (const at of [0.35, 0.6, 0.9]) {
      const branch = { ...B, at };
      const moved = go(s, { type: "branch", branch });
      expect(moved.onBranch).toBe(true);
      expect(moved.mode).toBe(s.mode);
      expect({ x: moved.x, lift: moved.lift }).toEqual(perchFor({ ...s, branch }));
      expect(moved.lift).not.toBe(s.lift);
    }
  });

  it("a bird flying to the branch flies on to where the perch is now; one on the ground stays put", () => {
    const up = beginFlight(ground(), T0, perchFor(ground()), true);
    const branch = { ...B, at: 0.4 };
    const retargeted = go(up, { type: "branch", branch }, T0 + 50);
    expect(retargeted.mode).toBe("flight");
    expect(retargeted.flight!.to).toEqual(perchFor({ ...up, branch }));
    const s = ground();
    const still = go(s, { type: "branch", branch });
    expect({ x: still.x, lift: still.lift, mode: still.mode }).toEqual({ x: s.x, lift: s.lift, mode: s.mode });
    expect(still.branch).toEqual(branch);
  });

  it("a bird held by the cursor isn't moved by the branch, and a bird drag never moves the branch", () => {
    let s = go(perched(), { type: "dragStart" }, T0 + 10_000);
    s = go(s, { type: "dragMove", x: 400, lift: 300, maxLift: H - DISPLAY_CELL.height }, T0 + 10_020);
    const held = go(s, { type: "branch", branch: { ...B, at: 0.3 } }, T0 + 10_030);
    expect({ x: held.x, lift: held.lift }).toEqual({ x: s.x, lift: s.lift });
    const dropped = go(go(s, { type: "dragMove", x: 300, lift: 0, maxLift: H }, T0 + 10_040), { type: "dragEnd" }, T0 + 10_050);
    expect(dropped.branch).toEqual(s.branch);
  });

  it("the branch has its own Ctrl press and handlers, apart from the bird's: they never start or move a bird drag", () => {
    const bird = readFileSync(new URL("./bird.ts", import.meta.url), "utf8");
    const start = bird.indexOf("// ── Moving the branch");
    const end = bird.indexOf("// ── The world around it");
    expect(start).toBeGreaterThan(0);
    const branchPart = bird.slice(start, end);
    // Its press: the left button with Ctrl, on the branch, never during a bird press or rub.
    expect(branchPart).toMatch(/branch\.addEventListener\("pointerdown", \(e\) => \{\s*if \(e\.button !== 0 \|\| !e\.ctrlKey \|\| press \|\| rub/);
    expect(branchPart).not.toMatch(/el\.addEventListener/);
    expect(branchPart).not.toMatch(/type: "drag(Start|Move|End)"/);
    expect(branchPart).toMatch(/dispatch\(\{ type: "branch", branch: placeBranch\(\) \}\)/);
    // It saves the height on this PC when let go.
    expect(branchPart).toMatch(/saveBranchAt\(storage\(\), branchAt\)/);
    // The bird's own press and drag stay on the bird's element.
    expect(bird).toMatch(/el\.addEventListener\("pointerdown", \(e\) => \{\s*if \(e\.button !== 0 \|\| rub\) return;/);
  });

  it("Rust is sent the branch's box while it is shown, for the Ctrl grab; parrot settings can reset it", () => {
    const bird = readFileSync(new URL("./bird.ts", import.meta.url), "utf8");
    expect(bird).toMatch(/const grab = branchShown\(state, now\) \? physicalBox\(branchBox\(/);
    expect(bird).toMatch(/invoke\("companion_set_hitbox", \{ boxes, fade, branch: grab \}\)/);
    const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    expect(main).toMatch(/listen\("parrot:branch-reset", \(\) => bird\.resetBranch\(\)\)/);
    const settings = readFileSync(new URL("../components/CompanionSettings.tsx", import.meta.url), "utf8");
    expect(settings).toMatch(/Reset branch position/);
    expect(settings).toMatch(/saveBranchAt\(window\.localStorage, undefined\)/);
    expect(settings).toMatch(/emitTo\("parrot", "parrot:branch-reset"\)/);
  });
});
