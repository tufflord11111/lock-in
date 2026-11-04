/** The overlay window's entry: plain TS, no React, no Firebase. */
import "../theme/parrot.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { createBird } from "./bird";

/** Mirrors companion.rs's World. Booleans only: no process or app names. */
type World = { session_active: boolean; fullscreen: boolean; user_idle: boolean };

const BACKSTOP_MS = 60_000;

async function boot() {
  if (getCurrentWebviewWindow().label !== "parrot") {
    throw new Error("parrot.html loaded outside the parrot window");
  }
  const el = document.getElementById("bird");
  if (!el) throw new Error("No #bird element");

  const first = await invoke<World>("companion_state").catch(() => null);
  const bird = createBird(el, {
    sessionActive: first?.session_active ?? false,
    onClick: () => {},
    extraRects: () => [],
  });

  const applyWorld = (world: World) => {
    bird.dispatch({ type: "session", active: world.session_active });
    bird.dispatch({ type: "hidden", hidden: world.fullscreen });
  };
  await listen<World>("parrot-world", (e) => applyWorld(e.payload));
  await listen<{ reason: string; timestamp: number }>("enforcer-stood-down", (e) =>
    bird.dispatch({ type: "stoodDown", reason: e.payload.reason }),
  );
  // A missed event heals itself within a minute.
  window.setInterval(() => {
    invoke<World>("companion_state").then(applyWorld).catch(() => {});
  }, BACKSTOP_MS);

  bird.refreshHitboxes();
  // A hidden webview may never fire rAF, so wait for the sheet, not for a frame.
  const sheet = new Image();
  sheet.src = getComputedStyle(el).backgroundImage.slice(5, -2);
  await sheet.decode().catch(() => {});
  await invoke("companion_ready").catch(() => {});
}

void boot();
