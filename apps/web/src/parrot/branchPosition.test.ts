import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DISPLAY_CELL } from "./animator";
import { birdBox } from "./layout";
import { beginFlight, initialState, perchFor, reduce, type BirdEvent, type BirdState } from "./machine";
import {
  BRANCH_AT_KEY,
  BRANCH_DRAWINGS,
  BRANCH_PREVIEW_HOLD_MS,
  DEFAULT_BRANCH_AT,
  branchAtFor,
  branchAtRange,
  branchBox,
  branchOf,
  branchTop,
  branchTopMin,
  clampBranchAt,
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

});

describe("the branch's height is set with parrot settings' slider, never by dragging the branch", () => {
  it("the slider's range is the work-area clamp, and every value in it is reachable", () => {
    for (const b of DRAWINGS) {
      for (const h of [600, 900, 1400]) {
        const { min, max } = branchAtRange(h, b);
        expect(min).toBeLessThan(max);
        expect(min).toBeCloseTo((branchTopMin(b) + b.perchY) / h, 6);
        expect(max).toBeCloseTo((h - b.height + b.perchY) / h, 6);
        expect(DEFAULT_BRANCH_AT).toBeGreaterThanOrEqual(min);
        expect(DEFAULT_BRANCH_AT).toBeLessThanOrEqual(max);
        // Out of range clamps to the ends; inside, the branch sits where the slider says.
        expect(clampBranchAt(0, h, b)).toBeCloseTo(min, 2);
        expect(clampBranchAt(1, h, b)).toBeCloseTo(max, 2);
        const mid = (min + max) / 2;
        expect(branchTop(h, { ...b, at: clampBranchAt(mid, h, b) }) + b.perchY).toBeCloseTo(h * mid, 0);
      }
    }
  });

  it("stays 2 s after the slider is let go, then hides unless in use", () => {
    expect(BRANCH_PREVIEW_HOLD_MS).toBe(2000);
    const bird = readFileSync(new URL("./bird.ts", import.meta.url), "utf8");
    // Shown while previewed, never faded then, and no fade zone goes to Rust then.
    expect(bird).toMatch(/const shown = branchShown\(state, now\) \|\| previewing;/);
    expect(bird).toMatch(/"parrot-faded", faded && shown && !previewing\)/);
    expect(bird).toMatch(/const zone = previewing \? null : fadeZone\(/);
    // Moving previews with no timer; letting go saves and starts the 2 s.
    expect(bird).toMatch(/previewBranch: \(at: number\) => \{[^}]*preview\(\);/);
    expect(bird).toMatch(/setBranchHeight: \(at: number\) => \{[^}]*saveBranchAt\(storage\(\), branchAt\);\s*preview\(BRANCH_PREVIEW_HOLD_MS\);/);
    // After the hold it's shown again only if branchShown says the bird is using it.
    expect(bird).toMatch(/previewEnds = window\.setTimeout\(\(\) => \{\s*previewing = false;/);
  });

  it("the branch takes no pointer: no handlers on it, nothing sent to Rust for it, no key state read", () => {
    const bird = readFileSync(new URL("./bird.ts", import.meta.url), "utf8");
    expect(bird).not.toMatch(/branch\.addEventListener/);
    expect(bird).not.toMatch(/ctrlKey|setPointerCapture\(e\.pointerId\);\s*branchPress/);
    expect(bird).toMatch(/invoke\("companion_set_hitbox", \{ boxes, fade \}\)/);
    const css = readFileSync(new URL("../theme/parrot.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/\.parrot-branch[^{]*\{[^}]*pointer-events: auto/);
    const rust = readFileSync(new URL("../../../desktop/src-tauri/src/companion.rs", import.meta.url), "utf8");
    expect(rust).not.toMatch(/GetAsyncKeyState|GetKeyState|SetWindowsHookEx|grabs_branch/);
  });

  it("parrot settings has the Branch height slider and Reset branch position, wired to the overlay", () => {
    const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    expect(main).toMatch(/listen\("parrot:branch-reset", \(\) => bird\.resetBranch\(\)\)/);
    expect(main).toMatch(/listen<\{ at: number \}>\("parrot:branch-preview", \(e\) => bird\.previewBranch\(e\.payload\.at\)\)/);
    expect(main).toMatch(/listen<\{ at: number \}>\("parrot:branch-set", \(e\) => bird\.setBranchHeight\(e\.payload\.at\)\)/);
    expect(main).toMatch(/emitTo\("main", "parrot:branch-range", bird\.branchRange\(\)\)/);
    const settings = readFileSync(new URL("../components/CompanionSettings.tsx", import.meta.url), "utf8");
    expect(settings).toMatch(/Branch height/);
    expect(settings).toMatch(/type="range"/);
    expect(settings).toMatch(/emitTo\("parrot", "parrot:branch-preview", \{ at: value \}\)/);
    expect(settings).toMatch(/onPointerUp=\{commit\}/);
    expect(settings).toMatch(/emitTo\("parrot", "parrot:branch-set", \{ at \}\)/);
    expect(settings).toMatch(/Reset branch position/);
    expect(settings).toMatch(/saveBranchAt\(window\.localStorage, undefined\)/);
    expect(settings).toMatch(/emitTo\("parrot", "parrot:branch-reset"\)/);
    expect(settings).not.toMatch(/Ctrl/);
  });
});
