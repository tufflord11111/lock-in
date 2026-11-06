/**
 * The bird on screen: one cell-sized element moved by transform, never a
 * full-page canvas, so only its own small rectangle repaints. Owns the one
 * animation loop, the drag and the hitboxes.
 */
import { invoke } from "@tauri-apps/api/core";
import { DISPLAY_CELL, createLoop, frameAt, frameSource, rowOf, scaleFor, type LoopPlan } from "./animator";
import { birdBox, dragPosition, physicalBox } from "./layout";
import {
  frameIndex,
  initialState,
  isStill,
  loopPlan,
  reduce,
  spriteState,
  type BirdEvent,
  type BirdState,
} from "./machine";

const CLICK_MAX_MS = 200;
const CLICK_MAX_PX = 4;
/** Well inside Rust's slack around the hitbox at walking speed; a drag is pinned clickable. */
const HITBOX_EVERY_MS = 200;

export type Bird = {
  dispatch: (event: BirdEvent) => void;
  state: () => BirdState;
  /** Call when something else that takes clicks appears, moves or goes. */
  refreshHitboxes: () => void;
  /** Resolves once the first frame's image is decoded and on the element. */
  ready: () => Promise<void>;
};

export function createBird(
  el: HTMLElement,
  options: { sessionActive: boolean; onClick: (trigger: string) => void; extraRects: () => DOMRect[] },
): Bird {
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let state = initialState(Date.now(), window.innerWidth, motion.matches, options.sessionActive, Math.random(), DISPLAY_CELL);
  el.style.width = `${DISPLAY_CELL.width}px`;
  el.style.height = `${DISPLAY_CELL.height}px`;
  let lastPlan: LoopPlan["kind"] = "stop";
  let drawn = "";
  let sentBoxes = "";
  let sentAt = 0;

  // ── The sheet, or the row of it, behind the element ────────────────────
  // The image is swapped only once it is decoded, so a row the page has not
  // shown yet never leaves the element blank: the old frame holds for the few
  // ms the decode takes. Each image is decoded once; the webview keeps the
  // bitmaps of the rows it has shown and may drop the ones it has not for a while.
  let shownFile = "";
  let wantedFile = "";
  const decoded = new Map<string, Promise<void>>();
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => (resolveReady = resolve));

  const decode = (file: string): Promise<void> => {
    let p = decoded.get(file);
    if (!p) {
      const img = new Image();
      img.src = `${import.meta.env.BASE_URL}${file}`;
      // A failed decode still swaps: a broken image is a bug to see, not a frozen bird.
      p = img.decode().catch(() => {});
      decoded.set(file, p);
    }
    return p;
  };

  const show = (file: string, size: { width: number; height: number }, position: { x: number; y: number }) => {
    if (file !== shownFile) {
      shownFile = file;
      el.style.backgroundImage = `url("${import.meta.env.BASE_URL}${file}")`;
      el.style.backgroundSize = `${size.width}px ${size.height}px`;
      resolveReady();
    }
    el.style.backgroundPosition = `${position.x}px ${position.y}px`;
  };

  const sendHitboxes = (now: number, force: boolean) => {
    if (!force && now - sentAt < HITBOX_EVERY_MS) return;
    const dpr = window.devicePixelRatio;
    const boxes = [
      birdBox(state, window.innerHeight),
      ...options.extraRects().map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })),
    ].map((b) => physicalBox(b, dpr));
    const key = JSON.stringify(boxes);
    if (key === sentBoxes) return;
    sentBoxes = key;
    sentAt = now;
    invoke("companion_set_hitbox", { boxes }).catch(() => {});
  };

  const draw = (now: number) => {
    const name = spriteState(state);
    const frame = frameIndex(state, now, (s, elapsed) => frameAt(rowOf(s), elapsed));
    const source = frameSource(scaleFor(window.devicePixelRatio), name, frame);
    const key = `${source.file}:${frame}:${state.x}:${state.lift}:${state.facing}`;
    if (key === drawn) return;
    drawn = key;
    el.style.transform = `translate3d(${state.x}px, ${-state.lift}px, 0) scaleX(${state.facing})`;
    if (source.file === shownFile) {
      show(source.file, source.size, source.position);
      return;
    }
    wantedFile = source.file;
    void decode(source.file).then(() => {
      // Superseded by a later row, or already shown by one: nothing to do.
      if (wantedFile !== source.file || shownFile === source.file) return;
      drawn = "";
      draw(Date.now());
    });
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
      const plan = loopPlan(state, now);
      sendHitboxes(now, isStill(state));
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
      ...dragPosition({ x: e.clientX, y: e.clientY }, { x: press.grabX, y: press.grabY }, window.innerHeight, state.cell),
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
  // A DPI change resizes the window too, so the sheet follows through draw().
  window.addEventListener("resize", () => {
    drawn = "";
    dispatch({ type: "resize", width: window.innerWidth });
    sendHitboxes(Date.now(), true);
  });

  loop.poke();

  return {
    dispatch,
    state: () => state,
    refreshHitboxes: () => sendHitboxes(Date.now(), true),
    ready: () => ready,
  };
}
