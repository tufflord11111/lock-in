/** The overlay window's entry: plain TS, no React, no Firebase. */
import "../theme/parrot.css";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
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

  await listen<NativeWorld>("parrot-world", (e) => applyWorld(e.payload));
  await listen<boolean>("parrot-fade", (e) => bird.setFaded(e.payload));
  await listen<{ reason: string; timestamp: number }>("enforcer-stood-down", (e) => {
    const finished = finishedOnTime(e.payload.reason, plannedEndAt, e.payload.timestamp);
    plannedEndAt = null;
    bird.dispatch({ type: "stoodDown", finished });
    talk.sessionEnded(finished, e.payload.timestamp);
  });
  await listen<Settings>("companion:settings", (e) => talk.setSettings(e.payload));
  await listen("companion:start-refused", () => talk.startRefused());
  // Parrot settings' Reset branch position (the main window also clears the saved height).
  await listen("parrot:branch-reset", () => bird.resetBranch());
  // Parrot settings' Branch height slider: moving shows the branch there, letting go saves it.
  await listen<{ at: number }>("parrot:branch-preview", (e) => bird.previewBranch(e.payload.at));
  await listen<{ at: number }>("parrot:branch-set", (e) => bird.setBranchHeight(e.payload.at));
  // The slider asks for its range, which depends on this overlay's work area and branch drawing.
  await listen("parrot:branch-range?", () => void emitTo("main", "parrot:branch-range", bird.branchRange()).catch(() => {}));
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

  // Main answers with the settings. Until then the bird stays silent.
  await emitTo("main", "companion:hello");
  if (TOUR) startTour(bird);

  bird.refreshHitboxes();
  // A hidden webview may never fire rAF, so wait for the first image, not for a frame.
  await bird.ready();
  await invoke("companion_ready").catch(() => {});
}

void boot();
