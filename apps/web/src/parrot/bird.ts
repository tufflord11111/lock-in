/**
 * The bird on screen: one cell-sized element moved by transform, never a
 * full-page canvas, so only its own small rectangle repaints. Owns the one
 * animation loop, the drag and the hitboxes.
 */
import { invoke } from "@tauri-apps/api/core";
import { DISPLAY_CELL, LID_COLOUR, contactAt, createLoop, eyeAt, frameAt, frameRect, headAt, layerRect, rowOf, scaleFiles, scaleFor, type LoopPlan } from "./animator";
import { lookFor, wantedFiles } from "./look";
import { blinkPlan, canBlink, combinePlans, firstBlink, lidAt, lidBox, lidOver, stepBlink } from "./blink";
import { alphaBounds, birdBox, dragPosition, grabOffset, inkBox, physicalBox, type Box } from "./layout";
import {
  BRANCH_AT_KEY,
  BRANCH_PREVIEW_HOLD_MS,
  branchAtFor,
  branchAtRange,
  branchBox,
  branchTop,
  clampBranchAt,
  branchDrawingFor,
  branchOf,
  branchShown,
  cursorBoxes,
  fadeZone,
  feetOnBranch,
  loadBranchAt,
  perchDy,
  saveBranchAt,
  shadowBox,
  type Branch,
} from "./perch";
import { createSpriteCache } from "./spriteCache";
import { PET_IDLE_MS, PET_START_PX, cursorSide, leanFor } from "./pet";
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
  /** Rust's word: the cursor is near the branch, so it, its shadow and the front grip fade (the bird never does). */
  setFaded: (faded: boolean) => void;
  /** Debug builds: a line in the frame check's log. */
  debugNote: (text: string) => void;
  /** Decoded sprite memory held right now, bytes. */
  spriteBytes: () => number;
  /** Parrot settings' Reset branch position: back to the default height, and forgotten on this PC. */
  resetBranch: () => void;
  /** The Branch height slider is moving: the branch shows there, solid, until setBranchHeight. */
  previewBranch: (at: number) => void;
  /** The slider was let go: saved on this PC, and hidden again 2 s later unless in use. */
  setBranchHeight: (at: number) => void;
  /** The slider's range for this work area (perch fraction), and where the branch is now. */
  branchRange: () => { min: number; max: number; at: number };
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

  // meta.branch.drawOrder: the branch, its shadow, the bird, then the front grip
  // (a canvas inside the bird's box, below). The branch and the shadow are never
  // hit-tested (neither is in the boxes Rust gets), and are there only when
  // needed: branchShown and feetOnBranch say when.
  const branch = document.createElement("div");
  branch.className = "parrot-branch";
  branch.setAttribute("aria-hidden", "true");
  el.before(branch);
  const shadow = document.createElement("div");
  shadow.className = "parrot-branch-shadow";
  shadow.setAttribute("aria-hidden", "true");
  el.before(shadow);
  const url = (file: string) => `url("${import.meta.env.BASE_URL}${file}")`;
  const setBox = (node: HTMLElement, box: { x: number; y: number; w: number; h: number } | null, file?: string) => {
    node.style.display = box && file ? "block" : "none";
    if (!box || !file) return;
    node.style.left = `${box.x}px`;
    node.style.top = `${box.y}px`;
    node.style.width = `${box.w}px`;
    node.style.height = `${box.h}px`;
    node.style.backgroundImage = url(file);
    node.style.backgroundSize = `${box.w}px ${box.h}px`;
  };
  /** Where the user put the branch, as a fraction of the work area's height; undefined: the default. */
  const storage = (): Storage | null => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  };
  let branchAt = loadBranchAt(storage());
  /** Places the drawing for this display, at the user's height, and says where its perch is. */
  const placeBranch = (): Branch => {
    const drawing = branchDrawingFor(window.devicePixelRatio);
    const b: Branch = { ...branchOf(drawing), ...(branchAt !== undefined ? { at: branchAt } : {}) };
    setBox(branch, drawing ? branchBox(window.innerWidth, window.innerHeight, b) : null, drawing?.file);
    setBox(shadow, drawing?.shadow ? shadowBox(window.innerWidth, window.innerHeight, b) : null, drawing?.shadow?.file);
    return b;
  };
  state = { ...state, branch: placeBranch() };
  if (state.onBranch) state = reduce(state, { type: "resize", width: state.width, height: state.height }, Date.now(), Math.random());
  let faded = false;
  /**
   * Parrot settings' Branch height slider is being moved, or was let go under 2 s
   * ago: the branch shows at that height, solid (never faded) and click-through,
   * so the user sees where it goes.
   */
  let previewing = false;
  let propsKey = "";
  /**
   * The branch, its shadow and the grip shown or not, and faded together by a
   * nearby cursor. The bird never fades.
   */
  const showProps = (now: number) => {
    const shown = branchShown(state, now) || previewing;
    const feet = feetOnBranch(state, now);
    const key = `${shown}:${feet}:${faded}:${previewing}`;
    if (key === propsKey) return;
    propsKey = key;
    branch.classList.toggle("parrot-shown", shown);
    shadow.classList.toggle("parrot-shown", feet);
    branch.classList.toggle("parrot-faded", faded && shown && !previewing);
    shadow.classList.toggle("parrot-faded", faded && feet);
    grip.classList.toggle("parrot-faded", faded && feet);
  };
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
  // The front grip (meta.layers.frontGrip): its own canvas right over the bird's, in the
  // bird's box, so it is placed, mirrored and lowered by rowDy exactly as the bird cell is,
  // but fades with the branch while the bird doesn't. It takes no pointer: a grab goes
  // through it to the bird.
  const grip = document.createElement("canvas");
  grip.className = "parrot-sprite parrot-grip";
  grip.setAttribute("aria-hidden", "true");
  canvas.after(grip);
  const ctx = canvas.getContext("2d");
  const gripCtx = grip.getContext("2d");
  let canvasFor = 0;
  const baseline = DISPLAY_CELL.baseline ?? DISPLAY_CELL.height;
  const sizeCanvas = () => {
    const dpr = window.devicePixelRatio;
    if (dpr === canvasFor) return;
    canvasFor = dpr;
    for (const c of [canvas, grip]) {
      c.width = Math.round(DISPLAY_CELL.width * dpr);
      c.height = Math.round(DISPLAY_CELL.height * dpr);
    }
    drawnFrame = "";
    // A lean pivots on the feet, where the art has them while petted; the grip leans with the bird.
    const feet = contactAt("pet", 0)?.cx ?? DISPLAY_CELL.width / 2;
    canvas.style.transformOrigin = `${feet}px ${baseline}px`;
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

  // The drawn frame's opaque box, CSS px in the cell, measured once per frame drawn.
  const inks = new Map<string, Box | null>();
  let ink: Box | null = null;
  const measureInk = (frameKey: string) => {
    if (!inks.has(frameKey) && ctx) {
      const found = alphaBounds(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
      const k = canvas.width / DISPLAY_CELL.width;
      inks.set(frameKey, found && { x: found.x / k, y: found.y / k, w: found.w / k, h: found.h / k });
    }
    ink = inks.get(frameKey) ?? null;
  };

  const sendHitboxes = (now: number, force: boolean) => {
    if (!force && now - sentAt < HITBOX_EVERY_MS) return;
    const dpr = window.devicePixelRatio;
    const extra = options.extraRects().map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height }));
    // Only the bird's drawn pixels take the cursor, not its whole, mostly empty, cell.
    const drawn = ink && inkBox(state, window.innerHeight, ink, turnPose(state, now).scaleX, rowDy(now));
    const boxes = cursorBoxes(state, window.innerHeight, extra, drawn).map((b) => physicalBox(b, dpr));
    // The branch's fade zone: the bird is never in it, and its own box always takes the cursor.
    // None while the height is previewed, so the branch stays solid then.
    const zone = previewing ? null : fadeZone(state, window.innerWidth, window.innerHeight, now);
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
    el.style.transform = `translate3d(${state.x}px, ${dip - state.lift + rowDy(now)}px, 0) scaleX(${scaleX})`;
  };
  /** B's rule: with its feet on the branch, each row sits rowDy lower (it may be negative); bird and grip alike. */
  const rowDy = (now: number) => (feetOnBranch(state, now) ? perchDy(state.branch, spriteState(state, now)) : 0);

  const draw = (now: number) => {
    const name = spriteState(state, now);
    const frame = frameIndex(state, now, (s, elapsed) => frameAt(rowOf(s), elapsed));
    const scale = scaleFor(window.devicePixelRatio);
    const rect = frameRect(scale, name, frame);
    const shut = canBlink(state, name) ? lidAt(blink, now) : 0;
    const { scaleX, dip } = turnPose(state, now);
    const onBranch = feetOnBranch(state, now);
    const lean = leanNow(now, scale, frame, scaleX);
    const key = `${rect.file}:${frame}:${state.x}:${state.lift}:${scaleX}:${dip}:${shut}:${onBranch}:${lean}:${rowDy(now)}`;
    showProps(now);
    if (key === drawn) return;
    drawn = key;
    place(now);
    sizeCanvas();
    // On the screen it leans toward the cursor; inside the mirrored box that is the other way when facing in.
    // The bird leans; the grip never does. It takes only the box's place, mirroring and rowDy.
    canvas.style.transform = lean === 0 ? "" : `rotate(${lean * Math.sign(scaleX)}deg)`;
    // This row, and the rows it may need next, with their layers, decoded and held.
    sprites.want(wantedFiles(state, now, scale));
    // The look for where its feet are: the underband under it on the ground; the front grip over it on the branch.
    const look = lookFor(name, frame, onBranch);
    const under = look.under ? layerRect(scale, look.under, name, frame) : null;
    const over = look.over ? layerRect(scale, look.over, name, frame) : null;
    const bitmap = sprites.get(rect.file);
    const underBitmap = under ? sprites.get(under.file) : undefined;
    const overBitmap = over ? sprites.get(over.file) : undefined;
    const strip = (r: typeof under) => (r ? `${r.file}:${r.sx}` : "");
    const frameKey = `${rect.file}:${rect.sx}:${rect.sy}:${canvas.width}:${strip(under)}:${strip(over)}`;
    // The layers and the bird go up together, on the same frame, or the last frame stays.
    if (bitmap && (!under || underBitmap) && (!over || overBitmap) && ctx && gripCtx && frameKey !== drawnFrame) {
      const k = canvas.height / scale.cell.height;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (under && underBitmap) ctx.drawImage(underBitmap, under.sx, under.sy, under.sw, under.sh, 0, under.dy * k, canvas.width, under.sh * k);
      ctx.drawImage(bitmap, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, canvas.width, canvas.height);
      // The grip: the same frame's cell, drawn just as the bird's is, over it.
      gripCtx.clearRect(0, 0, grip.width, grip.height);
      if (over && overBitmap) gripCtx.drawImage(overBitmap, over.sx, over.sy, over.sw, over.sh, 0, over.dy * k, grip.width, over.sh * k);
      drawnFrame = frameKey;
      measureInk(frameKey);
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

  /** The lean now, degrees on the screen, rounded so a still hand doesn't redraw: toward the cursor from the head. */
  const leanNow = (now: number, scale: ReturnType<typeof scaleFor>, frame: number, scaleX: number): number => {
    if (state.mode !== "pet" || !state.pet || !rub) return 0;
    const head = headAt(scale, "pet", frame);
    if (head) {
      const headX = scaleX >= 0 ? state.x + head.x : state.x + state.cell.width - head.x;
      rub.side = cursorSide(rub.x, headX, rub.side);
    }
    // On the branch the feet are gripping: no lean there.
    return Math.round(leanFor(state.pet, now, state.reducedMotion, rub.side, feetOnBranch(state, now)) * 10) / 10;
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

  // ── Petting: the right button ──────────────────────────────────────────
  // Pressed on the bird and moved PET_START_PX, it is a rub; a right click alone does
  // nothing (and the overlay never shows a context menu). Pinned clickable like a drag.
  let rub: { x: number; y: number; side: -1 | 0 | 1; rubbing: boolean } | null = null;
  let fluffTimer = 0;
  const fluff = (on: boolean) => {
    window.clearTimeout(fluffTimer);
    // The bird's feathers only: the grip is the bark, which doesn't fluff.
    canvas.classList.toggle("parrot-fluff", on);
    // A still hand: the feathers settle again.
    if (on) fluffTimer = window.setTimeout(() => fluff(false), PET_IDLE_MS);
  };
  const endRub = () => {
    if (!rub) return;
    const { rubbing } = rub;
    rub = null;
    fluff(false);
    invoke("companion_set_dragging", { dragging: false }).catch(() => {});
    if (rubbing) dispatch({ type: "petEnd" });
  };
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 2 || press || rub) return;
    el.setPointerCapture(e.pointerId);
    rub = { x: e.clientX, y: e.clientY, side: 0, rubbing: false };
    invoke("companion_set_dragging", { dragging: true }).catch(() => {});
  });
  el.addEventListener("pointermove", (e) => {
    if (!rub) return;
    if (!rub.rubbing && Math.hypot(e.clientX - rub.x, e.clientY - rub.y) < PET_START_PX) return;
    rub.rubbing = true;
    rub.x = e.clientX;
    rub.y = e.clientY;
    // Asleep it isn't woken: it only fluffs a little while the hand moves.
    if (state.mode === "sleep") fluff(!state.reducedMotion);
    dispatch({ type: "petRub" });
  });
  el.addEventListener("pointerup", (e) => {
    if (e.button === 2) endRub();
  });
  el.addEventListener("pointercancel", endRub);
  el.addEventListener("lostpointercapture", endRub);

  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || rub) return;
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

  // ── The branch's height: parrot settings' slider, never a drag on the screen ──
  // Up and down the right edge only, clamped inside the work area (branchTop); a perched bird
  // rides it, one flying to it flies on. Saved on this PC as a fraction of the work area's height.
  // The branch itself never takes the cursor: no handlers here, and pointer-events none in CSS.
  const moveBranch = (at: number | undefined) => {
    branchAt = at;
    dispatch({ type: "branch", branch: placeBranch() });
    sendHitboxes(Date.now(), true);
  };
  let previewEnds: number | undefined;
  /** Shows the branch at its height, solid; `holdMs` set: hides it again that long after, unless in use. */
  const preview = (holdMs?: number) => {
    window.clearTimeout(previewEnds);
    previewing = true;
    if (holdMs !== undefined) {
      previewEnds = window.setTimeout(() => {
        previewing = false;
        showProps(Date.now());
        sendHitboxes(Date.now(), true);
      }, holdMs);
    }
    showProps(Date.now());
    sendHitboxes(Date.now(), true);
  };
  // Reset from the main window's parrot settings, or another window of the app, changes the saved height.
  window.addEventListener("storage", (e) => {
    if (e.key === BRANCH_AT_KEY || e.key === null) moveBranch(loadBranchAt(storage()));
  });

  // ── The world around it ────────────────────────────────────────────────
  motion.addEventListener("change", () => dispatch({ type: "reducedMotion", reduced: motion.matches }));
  // A DPI change resizes the window too, so the sheet follows through draw().
  window.addEventListener("resize", () => {
    drawn = "";
    fileBytes = scaleFiles(scaleFor(window.devicePixelRatio));
    dispatch({ type: "resize", width: window.innerWidth, height: window.innerHeight, branch: placeBranch() });
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
    setFaded: (on) => {
      faded = on;
      showProps(Date.now());
    },
    resetBranch: () => {
      saveBranchAt(storage(), undefined);
      moveBranch(undefined);
      preview(BRANCH_PREVIEW_HOLD_MS);
    },
    previewBranch: (at: number) => {
      moveBranch(clampBranchAt(at, window.innerHeight, state.branch));
      preview();
    },
    setBranchHeight: (at: number) => {
      moveBranch(clampBranchAt(at, window.innerHeight, state.branch));
      saveBranchAt(storage(), branchAt);
      preview(BRANCH_PREVIEW_HOLD_MS);
    },
    branchRange: () => ({ ...branchAtRange(window.innerHeight, state.branch), at: branchAtFor(branchTop(window.innerHeight, state.branch), window.innerHeight, state.branch) }),
  };
}
