import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTACT, ROWS, SCALES, contactAt, rowOf } from "./animator";
import {
  beginFlight,
  beginWalk,
  contactFrames,
  frameIndex,
  initialState,
  loopPlan,
  perchFor,
  reduce,
  spriteState,
  type BirdEvent,
  type BirdState,
} from "./machine";
import { PET_IDLE_MS, PET_LEAN_DEG, PET_START_PX, cursorSide, heldFrames, petLean, petTimes } from "./pet";
import { feetOnBranch } from "./perch";

const WIDTH = 1000;
const T0 = 1_000_000;
const start = (over: Partial<BirdState> = {}): BirdState => ({
  ...initialState(T0, WIDTH, false, false, 0),
  branchDueAt: Infinity,
  restUntil: T0 + 60_000,
  nextAt: T0 + 60_000,
  ...over,
});
const go = (s: BirdState, e: BirdEvent, now = T0, rand = 0.5) => reduce(s, e, now, rand);
const tick = (s: BirdState, now: number, rand = 0.5) => go(s, { type: "tick" }, now, rand);
const frame = (s: BirdState, now: number) => frameIndex(s, now, () => -1);
const landed = (s: BirdState): BirdState => (s.mode === "flight" && s.flight ? tick(s, s.flight.endAt) : s);
const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

/** Rubs every `every` ms from `from` to `to`, ticking as it goes; the state at `to`. */
function rubbing(s: BirdState, from: number, to: number, every = 50): BirdState {
  for (let t = from; t <= to; t += every) s = tick(go(s, { type: "petRub" }, t), t);
  return s;
}

describe("the pet row", () => {
  it("opens on 0 to 1, loops on 2 to 3 while rubbed (meta.loops.pet), closes on 4 to 5", () => {
    const row = rowOf("pet");
    expect(row.frames).toBe(6);
    expect(row.loopFrames).toEqual({ from: 2, to: 3 });
    expect(heldFrames(row)).toEqual({ from: 2, to: 3 });
    const ms = 1000 / row.fps;
    expect(petTimes(row)).toEqual({ openMs: 2 * ms, closeMs: 2 * ms });
  });
});

describe("petting with the right button", () => {
  const { openMs, closeMs } = petTimes();
  const ms = 1000 / rowOf("pet").fps;

  it("starts on the first rub: a right press that moved at least 3 px", () => {
    expect(PET_START_PX).toBe(3);
    const s = go(start(), { type: "petRub" });
    expect(s.mode).toBe("pet");
    expect(spriteState(s, T0)).toBe("pet");
    expect(frame(s, T0)).toBe(0);
  });

  it("a right click alone does nothing: no rub, no petting", () => {
    const s = start();
    expect(go(s, { type: "petEnd" })).toBe(s);
    const bird = source("./bird.ts");
    // A press with no rub only lets go of the pin.
    expect(bird).toMatch(/if \(!rub\.rubbing && Math\.hypot\(e\.clientX - rub\.x, e\.clientY - rub\.y\) < PET_START_PX\) return;/);
    expect(bird).toMatch(/if \(rubbing\) dispatch\(\{ type: "petEnd" \}\)/);
  });

  it("plays the opening, loops 2 to 3 while the hand keeps moving, closes 400 ms after it stops, then is idle again where it was", () => {
    const before = start();
    let s = go(before, { type: "petRub" });
    expect(frame(s, T0 + ms / 2)).toBe(0);
    expect(frame(s, T0 + ms * 1.5)).toBe(1);
    s = rubbing(s, T0, T0 + 3_000);
    expect(s.mode).toBe("pet");
    const seen = new Set<number>();
    for (let t = T0 + openMs; t < T0 + 3_000; t += 20) seen.add(frame(s, t));
    expect([...seen].sort()).toEqual([2, 3]);
    // The hand stops at T0 + 3000: still the loop for 400 ms, then 4 and 5.
    expect(frame(s, T0 + 3_000 + PET_IDLE_MS - 10)).toBeLessThanOrEqual(3);
    expect(frame(s, T0 + 3_000 + PET_IDLE_MS + 1)).toBe(4);
    expect(frame(s, T0 + 3_000 + PET_IDLE_MS + ms + 1)).toBe(5);
    expect(tick(s, T0 + 3_000 + PET_IDLE_MS + closeMs - 1).mode).toBe("pet");
    const after = tick(s, T0 + 3_000 + PET_IDLE_MS + closeMs);
    expect(after.mode).toBe("idle");
    expect(after).toMatchObject({ x: before.x, lift: 0, onBranch: false, facing: before.facing, restUntil: before.restUntil });
  });

  it("closes at once when the right button comes up", () => {
    let s = rubbing(go(start(), { type: "petRub" }), T0, T0 + 1_000);
    s = go(s, { type: "petEnd" }, T0 + 1_020);
    expect(frame(s, T0 + 1_021)).toBe(4);
    expect(tick(s, T0 + 1_020 + closeMs).mode).toBe("idle");
  });

  it("let go during the opening, it finishes the opening before it closes", () => {
    const s = go(go(start(), { type: "petRub" }), { type: "petEnd" }, T0 + 10);
    expect(frame(s, T0 + openMs - 1)).toBe(1);
    expect(frame(s, T0 + openMs + 1)).toBe(4);
  });

  it("rubbed again as it closes, it goes back to the held loop", () => {
    let s = rubbing(go(start(), { type: "petRub" }), T0, T0 + 1_000);
    s = go(s, { type: "petEnd" }, T0 + 1_000);
    s = go(s, { type: "petRub" }, T0 + 1_100);
    expect(s.mode).toBe("pet");
    expect([2, 3]).toContain(frame(s, T0 + 1_100));
  });

  it("perched on the branch, it is petted there and goes back to its stay, facing in, the grip over its toes", () => {
    const up = landed(beginFlight(start(), T0, perchFor(start()), true));
    expect(up.onBranch).toBe(true);
    const at = up.enteredAt + 1_000;
    let s = go(up, { type: "petRub" }, at);
    expect(s.mode).toBe("pet");
    expect(feetOnBranch(s, at)).toBe(true);
    s = go(s, { type: "petEnd" }, at + 500);
    const back = tick(s, at + 500 + closeMs);
    expect(back).toMatchObject({ mode: "idle", onBranch: true, x: up.x, lift: up.lift, facing: up.facing, restUntil: up.restUntil });
  });

  it("asleep it isn't woken: the rub changes nothing in the machine and the overlay only fluffs it 2%", () => {
    const flying = go(start(), { type: "session", active: true });
    const asleep = landed(flying);
    expect(asleep.mode).toBe("sleep");
    expect(go(asleep, { type: "petRub" }, flying.flight!.endAt + 10)).toBe(asleep);
    expect(go(asleep, { type: "petEnd" }, flying.flight!.endAt + 20)).toBe(asleep);
    expect(loopPlan(asleep, flying.flight!.endAt + 10).kind).toBe("stop");
    const css = source("../theme/parrot.css").replace(/\s+/g, " ");
    expect(css).toMatch(/@keyframes parrot-fluff \{ 50% \{ transform: scale\(1\.02\); \} \}/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{ \.parrot-sprite\.parrot-fluff \{ animation: none; \} \}/);
    expect(source("./bird.ts")).toMatch(/if \(state\.mode === "sleep"\) fluff\(!state\.reducedMotion\);/);
  });

  it("walking, it first stops on its next contact frame, then is petted, then rests", () => {
    const walking = beginWalk({ ...start(), x: 100 }, T0, 1, 4_000)!;
    expect(walking.walkSteps).toBeGreaterThan(3);
    const row = rowOf("walk");
    const t = T0 + (1.2 * 1000) / row.fps; // on stride 1
    let s = go(tick(walking, t), { type: "petRub" }, t);
    expect(s.mode).toBe("walk");
    expect(contactFrames(row)).toContain(s.walkSteps % row.frames);
    expect(s.walkSteps).toBeLessThan(walking.walkSteps);
    for (let now = t; s.mode === "walk"; now += 1000 / row.fps) s = tick(go(s, { type: "petRub" }, now), now);
    expect(s.mode).toBe("pet");
    expect(s.x).toBe(walking.fromX + s.walkSteps * row.stride!);
    s = go(s, { type: "petEnd" }, s.enteredAt + 500);
    const after = tick(s, s.enteredAt + 500 + closeMs);
    expect(["idle", "perch"]).toContain(after.mode);
    expect(after.restUntil).toBeGreaterThan(s.enteredAt);
  });

  it("let go before the walk has stopped, it just rests", () => {
    const walking = beginWalk({ ...start(), x: 100 }, T0, 1, 4_000)!;
    let s = go(walking, { type: "petRub" }, T0 + 10);
    s = go(s, { type: "petEnd" }, T0 + 20);
    for (let now = T0; s.mode === "walk"; now += 50) s = tick(s, now);
    expect(s.mode).not.toBe("pet");
  });

  it("in the air, picked up or falling it takes no notice", () => {
    const flying = beginFlight(start(), T0, perchFor(start()), true);
    expect(go(flying, { type: "petRub" }, T0 + 100)).toBe(flying);
    const held = go(start(), { type: "dragStart" });
    expect(go(held, { type: "petRub" })).toBe(held);
    const falling = { ...start(), mode: "fall" as const, fromLift: 200, lift: 200 };
    expect(go(falling, { type: "petRub" })).toBe(falling);
  });

  it("brings no bubbles: it never opens one, and the right button never reaches the click", () => {
    let s = rubbing(go(start(), { type: "petRub" }), T0, T0 + 2_000);
    expect(s.talking).toBe(false);
    s = tick(go(s, { type: "petEnd" }, T0 + 2_000), T0 + 2_000 + closeMs);
    expect(s.talking).toBe(false);
    expect(s.mode).not.toBe("talk");
    const bird = source("./bird.ts");
    expect(bird.match(/options\.onClick\(/g)).toHaveLength(1);
    expect(bird).toMatch(/if \(e\.button !== 0 \|\| rub\) return;/);
  });

  it("with a bubble open, it goes back to talking afterwards", () => {
    const talking = go(start(), { type: "talkStart" });
    let s = go(talking, { type: "petRub" }, T0 + 10);
    expect(s.mode).toBe("pet");
    s = tick(go(s, { type: "petEnd" }, T0 + 500), T0 + 500 + closeMs);
    expect(s.mode).toBe("talk");
  });

  it("leans 2 to 3 degrees toward the cursor, easing in on the opening and out on the closing", () => {
    expect(PET_LEAN_DEG).toBeGreaterThanOrEqual(2);
    expect(PET_LEAN_DEG).toBeLessThanOrEqual(3);
    let s = go(start(), { type: "petRub" });
    s = rubbing(s, T0, T0 + 1_000);
    const p = s.pet!;
    expect(petLean(p, T0, false, 1)).toBeCloseTo(0);
    expect(petLean(p, T0 + openMs / 2, false, 1)).toBeGreaterThan(0);
    expect(petLean(p, T0 + 800, false, 1)).toBeCloseTo(PET_LEAN_DEG);
    expect(petLean(p, T0 + 800, false, -1)).toBeCloseTo(-PET_LEAN_DEG);
    const stopped = go(s, { type: "petEnd" }, T0 + 1_000).pet!;
    expect(Math.abs(petLean(stopped, T0 + 1_000 + closeMs / 2, false, 1))).toBeLessThan(PET_LEAN_DEG);
    expect(petLean(stopped, T0 + 1_000 + closeMs, false, 1)).toBeCloseTo(0);
    // Which way: the cursor against the head, with a dead band over it.
    expect(cursorSide(110, 100, 0)).toBe(1);
    expect(cursorSide(90, 100, 0)).toBe(-1);
    expect(cursorSide(101, 100, -1)).toBe(-1);
    // Every pet frame has a head to lean from.
    for (const scale of SCALES) expect(scale.head?.pet?.every((h) => h !== null)).toBe(true);
  });

  it("under reduced motion holds frame 2 and doesn't lean, and is done as soon as the rub stops", () => {
    let s = go(start({ reducedMotion: true }), { type: "petRub" });
    expect(frame(s, T0)).toBe(2);
    s = rubbing(s, T0, T0 + 1_000);
    for (let t = T0; t < T0 + 1_400; t += 30) expect(frame(s, t)).toBe(2);
    expect(petLean(s.pet!, T0 + 800, true, 1)).toBe(0);
    // No frames to play: it waits for the hand to stop, then is idle.
    expect(loopPlan(s, T0 + 1_000)).toEqual({ kind: "wait", ms: PET_IDLE_MS });
    expect(tick(s, T0 + 1_000 + PET_IDLE_MS).mode).toBe("idle");
  });

  it("suppresses the context menu, and right-up tells Rust the press is over like left-up", () => {
    const main = source("./main.ts");
    expect(main).toMatch(/addEventListener\("contextmenu", \(e\) => e\.preventDefault\(\), true\)/);
    // Any button's pointerup: not filtered to the left one.
    expect(main).toMatch(/window\.addEventListener\("pointerup", pressEnded, true\)/);
    expect(main).toMatch(/companion_interaction_ended/);
    // Pinned clickable for the rub, as for a drag.
    const bird = source("./bird.ts");
    expect(bird).toMatch(/e\.button !== 2[\s\S]{0,200}companion_set_dragging", \{ dragging: true \}/);
  });
});

describe("petting on the branch: the feet are gripping", () => {
  const { openMs } = petTimes();

  it("has no lean on the branch, through the whole petting; on the ground it still leans", async () => {
    const { leanFor, petLean } = await import("./pet");
    const { beginFlight: fly, perchFor: perch } = await import("./machine");
    const ground = start();
    const perched = (() => {
      const up = fly(ground, T0, perch(ground), true);
      return tick(up, up.flight!.endAt);
    })();
    expect(perched.onBranch).toBe(true);
    const at = perched.enteredAt + 1_000;
    let s = go(perched, { type: "petRub" }, at);
    s = rubbing(s, at, at + 1_500);
    expect(s.mode).toBe("pet");
    expect(feetOnBranch(s, at + 1_000)).toBe(true);
    for (let t = at; t < at + 3_000; t += 25) {
      for (const side of [-1, 1] as const) expect(leanFor(s.pet!, t, false, side, feetOnBranch(s, t))).toBe(0);
    }
    // On the ground the same petting leans toward the cursor.
    const onGround = rubbing(go(start(), { type: "petRub" }), T0, T0 + 1_500);
    expect(feetOnBranch(onGround, T0 + openMs + 400)).toBe(false);
    expect(Math.abs(leanFor(onGround.pet!, T0 + openMs + 400, false, 1, false))).toBeGreaterThan(0);
    expect(leanFor(onGround.pet!, T0 + openMs + 400, false, 1, false)).toBe(petLean(onGround.pet!, T0 + openMs + 400, false, 1));
  });

  it("the overlay asks for the lean with the feet's place, so the branch gets none", () => {
    expect(source("./bird.ts")).toMatch(/leanFor\(state\.pet, now, state\.reducedMotion, rub\.side, feetOnBranch\(state, now\)\)/);
  });
});

describe("the front grip never leans, scales or fluffs", () => {
  it("bird.ts never transforms the grip, and only the bird's canvas fluffs", () => {
    const bird = source("./bird.ts");
    expect(bird).not.toMatch(/grip\.style\.(transform|transformOrigin|scale|rotate|translate)\b/);
    expect(bird).not.toMatch(/grip\.classList\.(toggle|add)\("parrot-fluff"/);
    expect(bird).toMatch(/canvas\.classList\.toggle\("parrot-fluff", on\)/);
  });

  it("no CSS rule that can apply to the grip, faded or not, sets a transform", () => {
    const css = source("../theme/parrot.css").replace(/\/\*[\s\S]*?\*\//g, "");
    // The classes the grip can ever have.
    const gripClasses = new Set(["parrot-sprite", "parrot-grip", "parrot-faded"]);
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = m[2];
      if (!/\b(transform|scale|rotate|translate)\s*:/.test(body)) continue;
      for (const selector of m[1].split(",").map((x) => x.trim())) {
        const parts = selector.match(/[#.][\w-]+/g) ?? [];
        const couldBeGrip = parts.length > 0 && parts.join("") === selector && parts.every((p) => p[0] === "." && gripClasses.has(p.slice(1)));
        expect(couldBeGrip, `${selector} sets a transform`).toBe(false);
      }
    }
  });
});

describe("v25: the ground pet leans and rocks, the branch pet doesn't", () => {
  const { openMs } = petTimes();

  /** The lean the overlay draws (bird.ts leanNow): leanFor with the feet's place, rounded to 0.1 degree. */
  const drawn = async (s: BirdState, t: number, side: -1 | 1) => {
    const { leanFor } = await import("./pet");
    return Math.round(leanFor(s.pet!, t, s.reducedMotion, side, feetOnBranch(s, t)) * 10) / 10;
  };

  it("on the ground: a non-zero lean toward the hand, flipping as it crosses the head (the rock)", async () => {
    const s = rubbing(go(start(), { type: "petRub" }), T0, T0 + 1_500);
    const t = T0 + openMs + 400;
    expect(s.mode).toBe("pet");
    expect(await drawn(s, t, 1)).toBe(PET_LEAN_DEG);
    expect(await drawn(s, t, -1)).toBe(-PET_LEAN_DEG);
  });

  it("on the ground right after the branch, flown down or dragged off: the same lean", async () => {
    const { beginFlight: fly, perchFor: perch } = await import("./machine");
    const up = fly(start(), T0, perch(start()), true);
    let s = tick(up, up.flight!.endAt);
    expect(s.onBranch).toBe(true);
    // Flown down: the stay is over, it flies to the ground and walks.
    let t = s.flight ? s.flight.endAt : up.flight!.endAt;
    s = { ...s, restUntil: t + 10, nextAt: t + 10 };
    for (let k = 0; k < 400 && (s.onBranch || s.mode === "flight"); k++) s = tick(s, (t += 50));
    expect(s.onBranch).toBe(false);
    s = rubbing(s, t, t + 3_000);
    expect(s.mode).toBe("pet");
    expect(feetOnBranch(s, t + 3_000)).toBe(false);
    expect(Math.abs(await drawn(s, t + 3_000, 1))).toBeGreaterThan(0);
    // Dragged off the branch and dropped in the open.
    let d = tick(up, up.flight!.endAt);
    let u = up.flight!.endAt;
    d = go(d, { type: "dragStart" }, (u += 10));
    d = go(d, { type: "dragMove", x: 300, lift: 0, maxLift: 800 }, (u += 10));
    d = go(d, { type: "dragEnd" }, (u += 10));
    for (let k = 0; k < 40 && d.mode === "fall"; k++) d = tick(d, (u += 50));
    d = rubbing(d, u, u + 1_500);
    expect(d.mode).toBe("pet");
    expect(d.onBranch).toBe(false);
    expect(Math.abs(await drawn(d, u + 1_500, -1))).toBeGreaterThan(0);
  });

  it("on the branch: lean 0 all the way through, either side", async () => {
    const { beginFlight: fly, perchFor: perch } = await import("./machine");
    const up = fly(start(), T0, perch(start()), true);
    const at = up.flight!.endAt + 1_000;
    const s = rubbing(go(tick(up, up.flight!.endAt), { type: "petRub" }, at), at, at + 1_500);
    expect(s.mode).toBe("pet");
    for (let t = at; t < at + 3_000; t += 50) for (const side of [-1, 1] as const) expect(await drawn(s, t, side)).toBe(0);
  });
});
