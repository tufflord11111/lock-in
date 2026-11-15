/** The overlay window's entry: plain TS, no React, no Firebase. */
import "../theme/parrot.css";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen, type EventCallback } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { createBird } from "./bird";
import { createChatter, type Chatter } from "./chatter";
import { finishedOnTime, type Settings } from "./nextBubble";
import { TOUR, startTour } from "./tour";

/** Mirrors companion.rs's World. No process or app names. */
type NativeWorld = {
  session_active: boolean;
  session_end_at: number | null;
  fullscreen: boolean;
  user_idle: boolean;
};

const BACKSTOP_MS = 60_000;

/**
 * How far boot got, on the page's <body data-boot>: "listeners 9/9 hello ok ready". Plain
 * text in the page, read with DevTools when diagnosing. Nothing reads it, and nothing in it
 * changes behaviour.
 */
const note = (part: string) => {
  document.body.dataset.boot = `${document.body.dataset.boot ?? ""} ${part}`.trim();
};

async function boot() {
  if (getCurrentWebviewWindow().label !== "parrot") {
    throw new Error("parrot.html loaded outside the parrot window");
  }
  const el = document.getElementById("bird");
  if (!el) throw new Error("No #bird element");

  const first = await invoke<NativeWorld>("companion_state").catch(() => null);
  let chatter: Chatter | null = null;
  const bird = createBird(el, {
    sessionActive: first?.session_active ?? false,
    onClick: (trigger) => chatter?.toggleMenu(trigger),
    extraRects: () => chatter?.rects() ?? [],
  });
  chatter = createChatter(bird);
  const talk = chatter;

  // Kept after the session ends, which is when it is needed.
  let plannedEndAt: number | null = null;
  const applyWorld = (world: NativeWorld) => {
    if (world.session_end_at !== null) plannedEndAt = world.session_end_at;
    // Touring (debug builds), the tour's made-up sessions stand in for the real one.
    if (!TOUR) bird.dispatch({ type: "session", active: world.session_active });
    bird.dispatch({ type: "hidden", hidden: world.fullscreen });
    talk.setWorld({ sessionActive: world.session_active, hidden: world.fullscreen, userIdle: world.user_idle });
  };
  if (first) applyWorld(first);

  // ── Setup that can't fail: first, so nothing later can skip it ──
  // A missed event heals itself within a minute.
  window.setInterval(() => {
    invoke<NativeWorld>("companion_state").then(applyWorld).catch(() => {});
  }, BACKSTOP_MS);
  // Rust gives the focus back when a press is over, if the overlay took it. In the next
  // task, so a button's click, which follows pointerup, runs first.
  const pressEnded = () => {
    window.setTimeout(() => void invoke("companion_interaction_ended").catch(() => {}), 0);
  };
  // Any button's: a right press (petting) is over on right-up just as a left one is on left-up.
  window.addEventListener("pointerup", pressEnded, true);
  window.addEventListener("pointercancel", pressEnded, true);
  // The right button pets the bird; the overlay never shows a context menu.
  window.addEventListener("contextmenu", (e) => e.preventDefault(), true);
  note("setup");

  // ── Listeners: each on its own, so one refused (a bad name, a closing window) can't stop the rest ──
  const on = <T>(event: string, handler: EventCallback<T>) =>
    listen<T>(event, handler).then(
      () => true,
      (err) => {
        console.warn(`[parrot] couldn't listen for ${event}:`, err);
        return false;
      },
    );
  const listening = await Promise.all([
    on<NativeWorld>("parrot-world", (e) => applyWorld(e.payload)),
    on<boolean>("parrot-fade", (e) => bird.setFaded(e.payload)),
    on<{ reason: string; timestamp: number }>("enforcer-stood-down", (e) => {
      const finished = finishedOnTime(e.payload.reason, plannedEndAt, e.payload.timestamp);
      plannedEndAt = null;
      bird.dispatch({ type: "stoodDown", finished });
      talk.sessionEnded(finished, e.payload.timestamp);
    }),
    on<Settings>("companion:settings", (e) => talk.setSettings(e.payload)),
    on("companion:start-refused", () => talk.startRefused()),
    // Parrot settings' Reset branch position (the main window also clears the saved height).
    on("parrot:branch-reset", () => bird.resetBranch()),
    // Parrot settings' Branch height slider: moving shows the branch there, letting go saves it.
    on<{ at: number }>("parrot:branch-preview", (e) => bird.previewBranch(e.payload.at)),
    on<{ at: number }>("parrot:branch-set", (e) => bird.setBranchHeight(e.payload.at)),
    // The slider asks for its range, which depends on this overlay's work area and branch drawing.
    on("parrot:branch-range-request", () => void emitTo("main", "parrot:branch-range", bird.branchRange()).catch(() => {})),
  ]);
  note(`listeners ${listening.filter(Boolean).length}/${listening.length}`);
  // A change between the first read and the world listener would otherwise wait for the backstop.
  void invoke<NativeWorld>("companion_state").then(applyWorld).catch(() => {});

  // Main answers with the settings. Until then the bird stays silent.
  const hello = await emitTo("main", "companion:hello").then(
    () => true,
    (err) => {
      console.warn("[parrot] couldn't say hello to the main window:", err);
      return false;
    },
  );
  note(hello ? "hello ok" : "hello failed");
  if (TOUR) startTour(bird);

  bird.refreshHitboxes();
  // A hidden webview may never fire rAF, so wait for the first image, not for a frame.
  await bird.ready();
  await invoke("companion_ready").catch(() => {});
  note("ready");
}

void boot().catch((err) => {
  console.error("[parrot] boot failed:", err);
  note("failed");
});
