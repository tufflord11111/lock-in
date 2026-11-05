/**
 * The bird on screen: one 96 px element moved by transform, never a full-page
 * canvas, so only its own small rectangle repaints. Owns the one animation loop,
 * the drag and the hitboxes.
 */
import { invoke } from "@tauri-apps/api/core";
import { COLUMNS, DISPLAY_CELL, SHEET_ROWS, cellOffset, createLoop, frameAt, rowOf, scaleFor, type LoopPlan } from "./animator";
import {
  STILL_STEP_MS,
  frameIndex,
  initialState,
  isStill,
  reduce,
  spriteState,
  type BirdEvent,
  type BirdState,
} from "./machine";

const CLICK_MAX_MS = 200;
const CLICK_MAX_PX = 4;
/** Rust hit-tests at 10 Hz, so a fresher rectangle than this would go unused. */
const HITBOX_EVERY_MS = 100;

export type Bird = {
  dispatch: (event: BirdEvent) => void;
  state: () => BirdState;
  /** Call when something else that takes clicks appears, moves or goes. */
  refreshHitboxes: () => void;
};

export function createBird(
  el: HTMLElement,
  options: { sessionActive: boolean; onClick: (trigger: string) => void; extraRects: () => DOMRect[] },
): Bird {
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let state = initialState(Date.now(), window.innerWidth, motion.matches, options.sessionActive, Math.random());
  let lastPlan: LoopPlan["kind"] = "stop";
  let drawn = "";
  let sheet = "";
  let sentBoxes = "";
  let sentAt = 0;

  const useSheet = () => {
    const file = scaleFor(window.devicePixelRatio).file;
    if (file === sheet) return;
    sheet = file;
    el.style.backgroundImage = `url("${import.meta.env.BASE_URL}${file}")`;
    el.style.backgroundSize = `${COLUMNS * DISPLAY_CELL}px ${SHEET_ROWS * DISPLAY_CELL}px`;
  };

  const sendHitboxes = (now: number, force: boolean) => {
    if (!force && now - sentAt < HITBOX_EVERY_MS) return;
    const dpr = window.devicePixelRatio;
    const top = window.innerHeight - DISPLAY_CELL - state.lift;
    const boxes = [
      { x: state.x * dpr, y: top * dpr, w: DISPLAY_CELL * dpr, h: DISPLAY_CELL * dpr },
      ...options.extraRects().map((r) => ({ x: r.x * dpr, y: r.y * dpr, w: r.width * dpr, h: r.height * dpr })),
    ].map((b) => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) }));
    const key = JSON.stringify(boxes);
    if (key === sentBoxes) return;
    sentBoxes = key;
    sentAt = now;
    invoke("companion_set_hitbox", { boxes }).catch(() => {});
  };

  const draw = (now: number) => {
    const name = spriteState(state);
    const frame = frameIndex(state, now, (s, elapsed) => frameAt(rowOf(s), elapsed));
    const key = `${name}:${frame}:${state.x}:${state.lift}:${state.facing}`;
    if (key === drawn) return;
    drawn = key;
    const cell = cellOffset(name, frame);
    el.style.backgroundPosition = `${cell.x}px ${cell.y}px`;
    el.style.transform = `translate3d(${state.x}px, ${-state.lift}px, 0) scaleX(${state.facing})`;
  };

  const loop = createLoop(
    {
      raf: (cb) => window.requestAnimationFrame(cb),
      cancelRaf: (id) => window.cancelAnimationFrame(id),
      setTimer: (cb, ms) => window.setTimeout(cb, ms),
      clearTimer: (id) => window.clearTimeout(id),
    },
    () => {
      const now = Date.now();
      state = reduce(state, { type: "tick" }, now, Math.random());
      draw(now);
      let plan: LoopPlan;
      if (state.hidden) plan = { kind: "stop" };
      else if (!isStill(state)) plan = { kind: "frames" };
      // Reduced motion: one pose, and nothing to do until something happens.
      else if (state.reducedMotion) plan = { kind: "stop" };
      else plan = { kind: "wait", ms: STILL_STEP_MS - ((now - state.enteredAt) % STILL_STEP_MS) };
      sendHitboxes(now, plan.kind !== "frames");
      lastPlan = plan.kind;
      return plan;
    },
  );

  const dispatch = (event: BirdEvent) => {
    state = reduce(state, event, Date.now(), Math.random());
    // Already drawing every frame: the next one picks this up, and the 30 Hz
    // cap holds however fast the pointer moves.
    if (lastPlan === "frames" && !isStill(state) && !state.hidden) return;
    loop.poke();
  };

  // ── Press, click and drag ──────────────────────────────────────────────
  let press: { at: number; x: number; y: number; grabX: number; grabY: number; dragging: boolean } | null = null;

  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    press = { at: Date.now(), x: e.clientX, y: e.clientY, grabX: e.clientX - r.left, grabY: e.clientY - r.top, dragging: false };
    invoke("companion_set_dragging", { dragging: true }).catch(() => {});
  });

  el.addEventListener("pointermove", (e) => {
    if (!press) return;
    if (!press.dragging) {
      const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y);
      if (moved < CLICK_MAX_PX && Date.now() - press.at < CLICK_MAX_MS) return;
      press.dragging = true;
      dispatch({ type: "dragStart" });
    }
    dispatch({
      type: "dragMove",
      x: e.clientX - press.grabX,
      lift: window.innerHeight - (e.clientY - press.grabY) - DISPLAY_CELL,
      maxLift: window.innerHeight - DISPLAY_CELL,
    });
  });

  const release = (up: PointerEvent | null) => {
    if (!press) return;
    const { dragging, at } = press;
    press = null;
    invoke("companion_set_dragging", { dragging: false }).catch(() => {});
    if (dragging) dispatch({ type: "dragEnd" });
    else if (up && Date.now() - at < CLICK_MAX_MS) {
      options.onClick(
        `pointerup type=${up.pointerType} trusted=${up.isTrusted} button=${up.button} held=${Date.now() - at}ms at=${Math.round(up.clientX)},${Math.round(up.clientY)}`,
      );
    }
  };
  el.addEventListener("pointerup", (e) => release(e));
  el.addEventListener("pointercancel", () => release(null));

  // ── The world around it ────────────────────────────────────────────────
  motion.addEventListener("change", () => dispatch({ type: "reducedMotion", reduced: motion.matches }));
  window.addEventListener("resize", () => {
    useSheet();
    dispatch({ type: "resize", width: window.innerWidth });
    sendHitboxes(Date.now(), true);
  });

  useSheet();
  loop.poke();

  return {
    dispatch,
    state: () => state,
    refreshHitboxes: () => sendHitboxes(Date.now(), true),
  };
}
