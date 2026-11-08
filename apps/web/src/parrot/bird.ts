/**
 * The bird on screen: one cell-sized element moved by transform, never a
 * full-page canvas, so only its own small rectangle repaints. Owns the one
 * animation loop, the drag and the hitboxes.
 */
import { invoke } from "@tauri-apps/api/core";
import { DISPLAY_CELL, LID_COLOUR, createLoop, eyeAt, frameAt, frameRect, rowOf, scaleFiles, scaleFor, type LoopPlan } from "./animator";
import { blinkPlan, canBlink, combinePlans, firstBlink, lidAt, lidBox, lidOver, stepBlink } from "./blink";
import { birdBox, dragPosition, grabOffset, physicalBox } from "./layout";
import { BRANCH, branchBox, branchImageFor, cursorBoxes, fadeZone } from "./perch";
import { createSpriteCache } from "./spriteCache";
import { DEBUG, createFrameLog } from "./frameCheck";
import {
  frameIndex,
  initialState,
  isStill,
  loopPlan,
  nextRows,
  reduce,
  spriteState,
  turnPose,
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
  /** Rust's word: the cursor is near the perched bird, so it and the branch fade. */
  setFaded: (faded: boolean) => void;
  /** Debug builds: a line in the frame check's log. */
  debugNote: (text: string) => void;
  /** Decoded sprite memory held right now, bytes. */
  spriteBytes: () => number;
};

export function createBird(
  el: HTMLElement,
  options: { sessionActive: boolean; onClick: (trigger: string) => void; extraRects: () => DOMRect[] },
): Bird {
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let state = initialState(
    Date.now(),
    window.innerWidth,
    motion.matches,
    options.sessionActive,
    Math.random(),
    DISPLAY_CELL,
    window.innerHeight,
  );
  el.style.width = `${DISPLAY_CELL.width}px`;
  el.style.height = `${DISPLAY_CELL.height}px`;

  // The branch: drawn behind the bird, never hit-tested (it isn't in the boxes Rust gets).
  const branch = document.createElement("div");
  branch.className = "parrot-branch";
  branch.setAttribute("aria-hidden", "true");
  el.before(branch);
  const placeBranch = () => {
    const image = branchImageFor(window.devicePixelRatio);
    if (!image) {
      branch.style.display = "none";
      return;
    }
    const box = branchBox(window.innerWidth, window.innerHeight);
    branch.style.display = "block";
    branch.style.left = `${box.x}px`;
    branch.style.top = `${box.y}px`;
    branch.style.width = `${BRANCH.width}px`;
    branch.style.height = `${BRANCH.height}px`;
    branch.style.backgroundImage = `url("${import.meta.env.BASE_URL}${image.file}")`;
    branch.style.backgroundSize = `${BRANCH.width}px ${BRANCH.height}px`;
  };
  placeBranch();
  let lastPlan: LoopPlan["kind"] = "stop";
  let blink = firstBlink(Date.now(), Math.random());

  // The lid: a disc over the art's eye, filled from the top, with an ink lower edge.
  const lid = document.createElement("div");
  lid.className = "parrot-lid";
  const lidFill = document.createElement("div");
  lidFill.className = "parrot-lid-fill";
  if (LID_COLOUR) lidFill.style.background = LID_COLOUR;
  lid.append(lidFill);
  el.append(lid);
  let lidShown = "";
  const showLid = (over: ReturnType<typeof lidOver>) => {
    const key = over ? `${over.eye.x}:${over.eye.y}:${over.eye.r}:${over.lid}` : "";
    if (key === lidShown) return;
    lidShown = key;
    if (!over) {
      lid.style.display = "none";
      return;
    }
    const box = lidBox(over.eye, over.lid);
    lid.style.display = "block";
    lid.style.left = `${box.left}px`;
    lid.style.top = `${box.top}px`;
    lid.style.width = lid.style.height = `${box.size}px`;
    lidFill.style.height = `${box.fill}px`;
  };
  let drawn = "";
  let sentBoxes = "";
  let sentAt = 0;

  // Debug builds: the frame check, written to parrot-debug.log (or kept on the page outside the app).
  const debugLines: string[] = [];
  (window as unknown as { __parrotDebug?: string[] }).__parrotDebug = debugLines;
  const frameLog = DEBUG
    ? createFrameLog((lines) => {
        debugLines.push(...lines);
        if (debugLines.length > 20_000) debugLines.splice(0, debugLines.length - 20_000);
        invoke("companion_debug_log", { lines }).catch(() => {});
      })
    : null;
  // ── The sprite: a canvas drawn from bitmaps the page holds ─────────────
  // A CSS background let the webview drop a row's decoded pixels once it was
  // off screen, and redecode it, blank, the next time it went up. Here a frame
  // is drawn only from a decoded bitmap the page owns; until the next one is
  // ready the canvas keeps the last frame. spriteCache.ts decodes the rows the
  // bird may show next ahead of time, within a memory budget.
  const canvas = document.createElement("canvas");
  canvas.className = "parrot-sprite";
  el.prepend(canvas);
  const ctx = canvas.getContext("2d");
  let canvasFor = 0;
  const sizeCanvas = () => {
    const dpr = window.devicePixelRatio;
    if (dpr === canvasFor) return;
    canvasFor = dpr;
    canvas.width = Math.round(DISPLAY_CELL.width * dpr);
    canvas.height = Math.round(DISPLAY_CELL.height * dpr);
    drawnFrame = "";
  };
  let drawnFrame = "";
  let shownFile = "";
  let resolveReady: () => void = () => {};
  const firstFrame = new Promise<void>((resolve) => (resolveReady = resolve));
  let fileBytes = scaleFiles(scaleFor(window.devicePixelRatio));
  const sprites = createSpriteCache<ImageBitmap>({
    decode: async (file) => {
      const img = new Image();
      img.src = `${import.meta.env.BASE_URL}${file}`;
      await img.decode();
      return createImageBitmap(img);
    },
    free: (bitmap) => bitmap.close(),
    bytesOf: (file) => fileBytes.get(file) ?? 0,
    // The frame it was waiting for, or a later one: draw whatever is current.
    onReady: () => {
      drawn = "";
      draw(Date.now());
    },
  });

  // Debug builds: the decoded sprite memory, twice a minute.
  if (frameLog) window.setInterval(() => frameLog.note(`memory sprites ${(sprites.bytes() / 2 ** 20).toFixed(1)} MiB in ${sprites.files().length} files`), 30_000);

  const sendHitboxes = (now: number, force: boolean) => {
    if (!force && now - sentAt < HITBOX_EVERY_MS) return;
    const dpr = window.devicePixelRatio;
    const extra = options.extraRects().map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height }));
    const boxes = cursorBoxes(state, window.innerHeight, extra).map((b) => physicalBox(b, dpr));
    const zone = fadeZone(state, window.innerWidth, window.innerHeight);
    const fade = zone ? physicalBox(zone, dpr) : null;
    const key = JSON.stringify([boxes, fade]);
    if (key === sentBoxes) return;
    sentBoxes = key;
    sentAt = now;
    invoke("companion_set_hitbox", { boxes, fade }).catch(() => {});
  };

  /**
   * Moves the element to the state's position, and squeezes it through a turn.
   * Compositor-only: no repaint. The flip pivots on the cell's centre, where
   * the feet stand.
   */
  const place = (now = Date.now()) => {
    const { scaleX, dip } = turnPose(state, now);
    el.style.transform = `translate3d(${state.x}px, ${dip - state.lift}px, 0) scaleX(${scaleX})`;
  };

  const draw = (now: number) => {
    const name = spriteState(state, now);
    const frame = frameIndex(state, now, (s, elapsed) => frameAt(rowOf(s), elapsed));
    const scale = scaleFor(window.devicePixelRatio);
    const rect = frameRect(scale, name, frame);
    const shut = canBlink(state, name) ? lidAt(blink, now) : 0;
    const { scaleX, dip } = turnPose(state, now);
    const key = `${rect.file}:${frame}:${state.x}:${state.lift}:${scaleX}:${dip}:${shut}`;
    if (key === drawn) return;
    drawn = key;
    place(now);
    sizeCanvas();
    // This row, and the rows it may need next, decoded and held.
    sprites.want(nextRows(state, now).map((row) => frameRect(scale, row, 0).file));
    const bitmap = sprites.get(rect.file);
    const frameKey = `${rect.file}:${rect.sx}:${rect.sy}:${canvas.width}`;
    if (bitmap && ctx && frameKey !== drawnFrame) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, canvas.width, canvas.height);
      drawnFrame = frameKey;
      if (shownFile === "") resolveReady();
      shownFile = rect.file;
    }
    // Only over the row on the canvas: while a new row decodes, the old frame stays up.
    showLid(shownFile === rect.file ? lidOver(eyeAt(scale, name, frame), shut) : null);
    frameLog?.frame(
      {
        row: name,
        frame,
        frames: rowOf(name).frames,
        wantedFile: rect.file,
        shownFile,
        hasImage: shownFile !== "",
        scaleX,
        lidShown: lid.style.display === "block",
        lidSize: parseFloat(lid.style.width) || 0,
        cellWidth: DISPLAY_CELL.width,
      },
      state.mode,
      state.x,
      state.lift,
    );
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
      const blinking = canBlink(state, spriteState(state, now));
      blink = stepBlink(blink, now, blinking, Math.random(), Math.random());
      draw(now);
      // Asleep, hidden or under reduced motion the blink adds nothing, so a stopped loop stays stopped.
      const plan = combinePlans(loopPlan(state, now), blinkPlan(blink, now, blinking));
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
    const grab = grabOffset({ x: e.clientX, y: e.clientY }, birdBox(state, window.innerHeight));
    press = { at: Date.now(), x: e.clientX, y: e.clientY, grabX: grab.x, grabY: grab.y, dragging: false };
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
    // Under the pointer now, not at the next 30 Hz step: waiting left the bird a
    // frame or two behind a fast hand. The sprite frame still changes on the loop.
    place();
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
  // Capture lost without an up or a cancel: drop the bird rather than leave it stuck to the cursor.
  el.addEventListener("lostpointercapture", () => release(null));

  // ── The world around it ────────────────────────────────────────────────
  motion.addEventListener("change", () => dispatch({ type: "reducedMotion", reduced: motion.matches }));
  // A DPI change resizes the window too, so the sheet follows through draw().
  window.addEventListener("resize", () => {
    drawn = "";
    fileBytes = scaleFiles(scaleFor(window.devicePixelRatio));
    placeBranch();
    dispatch({ type: "resize", width: window.innerWidth, height: window.innerHeight });
    sendHitboxes(Date.now(), true);
  });

  loop.poke();

  return {
    dispatch,
    debugNote: (text: string) => frameLog?.note(text),
    state: () => state,
    refreshHitboxes: () => sendHitboxes(Date.now(), true),
    ready: () => firstFrame,
    spriteBytes: () => sprites.bytes(),
    setFaded: (faded) => {
      el.classList.toggle("parrot-faded", faded);
      branch.classList.toggle("parrot-faded", faded);
    },
  };
}
