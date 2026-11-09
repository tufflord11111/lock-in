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
import { SHADOW_ALPHA_BRANCH, SHADOW_BLUR_PX, SHADOW_HEIGHT, SHADOW_WIDTH, shadowFor } from "./shadow";
import { frontShown } from "./perch";

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

  it("perched on the branch, it is petted there and goes back to its stay, facing in, the lip over its toes", () => {
    const up = landed(beginFlight(start(), T0, perchFor(start()), true));
    expect(up.onBranch).toBe(true);
    const at = up.enteredAt + 1_000;
    let s = go(up, { type: "petRub" }, at);
    expect(s.mode).toBe("pet");
    expect(frontShown(s, at)).toBe(true);
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

describe("the contact shadow", () => {
  it("is a soft ellipse from meta.contact: 1.1 times the footprint wide, 18% of it tall, 3 px of blur, on the feet line", () => {
    expect([SHADOW_WIDTH, SHADOW_HEIGHT, SHADOW_BLUR_PX]).toEqual([1.1, 0.18, 3]);
    const c = contactAt("perch", 0)!;
    expect(c.w).toBeGreaterThan(10);
    const s = shadowFor("perch", 0, true)!;
    expect(s.w).toBeCloseTo(c.w * 1.1);
    expect(s.h).toBeCloseTo(c.w * 0.18);
    expect(s.x + s.w / 2).toBeCloseTo(c.cx);
    expect(s.y + s.h / 2).toBeCloseTo(121.6);
    // One footprint per frame of every row, the 1x sheet's, in CSS px at every scale.
    for (const row of ROWS) expect(CONTACT[row.state], row.state).toHaveLength(row.frames);
  });

  it("is 0.35 on the branch, and not there at all on the ground (the underband stands it there)", () => {
    expect(SHADOW_ALPHA_BRANCH).toBe(0.35);
    expect(shadowFor("perch", 0, true)!.alpha).toBe(0.35);
    for (const row of ROWS) for (let f = 0; f < row.frames; f++) expect(shadowFor(row.state, f, false)).toBeNull();
  });

  it("has none in the air, and shrinks and fades through the takeoff and back through the landing", () => {
    for (let f = 0; f < rowOf("fly").frames; f++) expect(shadowFor("fly", f, false)).toBeNull();
    for (let f = 0; f < rowOf("drag").frames; f++) expect(shadowFor("drag", f, false)).toBeNull();
    const takeoff = Array.from({ length: rowOf("takeoff").frames }, (_, f) => shadowFor("takeoff", f, true));
    expect(takeoff[takeoff.length - 1]).toBeNull();
    const shown = takeoff.filter((s) => s !== null);
    for (let i = 1; i < shown.length; i++) {
      expect(shown[i]!.w).toBeLessThan(shown[i - 1]!.w);
      expect(shown[i]!.alpha).toBeLessThan(shown[i - 1]!.alpha);
    }
    const land = Array.from({ length: rowOf("land").frames }, (_, f) => shadowFor("land", f, true));
    expect(land[0]).toBeNull();
    expect(land[land.length - 1]!.alpha).toBe(SHADOW_ALPHA_BRANCH);
  });

  it("is drawn after the branch and before the bird, inside the bird's box, so it fades with the perched bird", () => {
    const bird = source("./bird.ts");
    // The branch goes before #bird; the shadow is put first inside it, after the canvas, so under the sprite.
    expect(bird.indexOf("el.before(branch)")).toBeGreaterThan(-1);
    expect(bird.indexOf("el.prepend(shadow)")).toBeGreaterThan(bird.indexOf("el.prepend(canvas)"));
    expect(bird.indexOf("el.after(front)")).toBeGreaterThan(-1);
    const css = source("../theme/parrot.css").replace(/\s+/g, " ");
    expect(css).toMatch(/#bird\.parrot-faded \{ opacity: 0\.2;/);
  });

  it("costs no redraw while asleep: the bird holds one frame and the shadow element is only touched when it changes", () => {
    const flying = go(start(), { type: "session", active: true });
    const asleep = landed(flying);
    const at = flying.flight!.endAt;
    expect(loopPlan(asleep, at).kind).toBe("stop");
    expect(frame(asleep, at)).toBe(0);
    expect(frame(asleep, at + 3_600_000)).toBe(0);
    expect(shadowFor("sleep", 0, true)).not.toBeNull();
    expect(source("./bird.ts")).toMatch(/if \(key === shadowShown\) return;/);
  });
});
