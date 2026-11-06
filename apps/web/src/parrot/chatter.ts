/**
 * Bubbles and the click menu. The decisions live in nextBubble.ts; this is the
 * clock tick, the local memory, and the DOM. Timings are local to this device:
 * nothing here goes to Firebase.
 */
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import type { Bird } from "./bird";
import { cardAnchor } from "./layout";
import {
  DEFAULT_SETTINGS,
  nextBubble,
  openAppBubble,
  quiet1hUntil,
  quietTodayUntil,
  sessionEndBubble,
  type Bubble,
  type BubbleAction,
  type Memory,
  type Settings,
  type World,
} from "./nextBubble";

const CHECK_EVERY_MS = 30_000;
const BUBBLE_MS = 12_000;
const MENU_MS = 10_000;
/** Long enough for wake and happy to play before the line appears. */
const AFTER_WAKE_MS = 1_400;
const CARD_GAP = 8;

const readNumber = (key: string): number | null => {
  const raw = localStorage.getItem(`parrot.${key}`);
  const value = raw === null ? NaN : Number(raw);
  return Number.isFinite(value) ? value : null;
};

function loadMemory(now: number): Memory {
  const lastSessionEndAt = readNumber("lastSessionEndAt");
  // First run: the clock starts now, so a new bird doesn't speak straight away.
  if (lastSessionEndAt === null) localStorage.setItem("parrot.lastSessionEndAt", String(now));
  return {
    lastSessionEndAt: lastSessionEndAt ?? now,
    lastBubbleAt: readNumber("lastBubbleAt"),
    quietUntil: readNumber("quietUntil"),
    helloShown: localStorage.getItem("parrot.helloShown") === "1",
  };
}

const remember = (key: "lastSessionEndAt" | "lastBubbleAt" | "quietUntil", value: number) =>
  localStorage.setItem(`parrot.${key}`, String(value));

const ACTION_LABEL: Record<BubbleAction, string> = {
  start25: "Start 25",
  notNow: "Not now",
  quiet1h: "Quiet 1h",
};

export type Chatter = {
  setSettings: (settings: Settings) => void;
  setWorld: (world: World) => void;
  sessionEnded: (finished: boolean, timestamp: number) => void;
  startRefused: () => void;
  toggleMenu: (trigger: string) => void;
  rects: () => DOMRect[];
};

export function createChatter(bird: Bird): Chatter {
  const memory = loadMemory(Date.now());
  let settings: Settings | null = null;
  let world: World = { sessionActive: bird.state().sessionActive, hidden: false, userIdle: false };
  let card: HTMLElement | null = null;
  let cardTimer: number | undefined;

  const closeCard = () => {
    window.clearTimeout(cardTimer);
    if (!card) return;
    card.remove();
    card = null;
    bird.dispatch({ type: "talkEnd" });
    bird.refreshHitboxes();
  };

  const openCard = (build: (el: HTMLElement) => void, className: string, lifetimeMs: number) => {
    closeCard();
    const el = document.createElement("div");
    el.className = className;
    build(el);
    document.body.append(el);
    card = el;
    bird.dispatch({ type: "talkStart" });
    // Above the bird, kept on the overlay.
    const { left, bottom } = cardAnchor(bird.state(), el.offsetWidth, CARD_GAP);
    el.style.left = `${left}px`;
    el.style.bottom = `${bottom}px`;
    bird.refreshHitboxes();
    cardTimer = window.setTimeout(closeCard, lifetimeMs);
  };

  const button = (label: string, onClick: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  };

  const quiet1h = () => {
    memory.quietUntil = quiet1hUntil(Date.now(), memory.quietUntil);
    remember("quietUntil", memory.quietUntil);
    closeCard();
  };

  const quietToday = () => {
    const quietEnd = (settings ?? DEFAULT_SETTINGS).quietEnd;
    memory.quietUntil = quietTodayUntil(Date.now(), quietEnd, memory.quietUntil);
    remember("quietUntil", memory.quietUntil);
    closeCard();
  };

  const start25 = () => {
    closeCard();
    void emitTo("main", "companion:start-session", { minutes: 25 });
  };

  const hide = () => {
    closeCard();
    void emitTo("main", "companion:hide");
  };

  const act: Record<BubbleAction, () => void> = { start25, notNow: closeCard, quiet1h };

  const show = (bubble: Bubble) => {
    openCard(
      (el) => {
        const line = document.createElement("p");
        line.textContent = bubble.text;
        const actions = document.createElement("div");
        actions.className = "parrot-actions";
        actions.append(...bubble.actions.map((a) => button(ACTION_LABEL[a], act[a])));
        el.append(line, actions);
      },
      "parrot-card",
      BUBBLE_MS,
    );
    // It is on screen now, so now it counts.
    memory.lastBubbleAt = Date.now();
    remember("lastBubbleAt", memory.lastBubbleAt);
    if (bubble.kind === "hello") {
      memory.helloShown = true;
      localStorage.setItem("parrot.helloShown", "1");
    }
  };

  const check = () => {
    if (card) return;
    const bubble = nextBubble(Date.now(), settings, memory, world);
    if (bubble) show(bubble);
  };

  window.setInterval(check, CHECK_EVERY_MS);

  return {
    setSettings(next) {
      settings = next;
    },
    setWorld(next) {
      world = next;
      if (next.sessionActive || next.hidden) closeCard();
    },
    sessionEnded(finished, timestamp) {
      memory.lastSessionEndAt = timestamp;
      remember("lastSessionEndAt", timestamp);
      world = { ...world, sessionActive: false };
      window.setTimeout(() => {
        if (card) return;
        const bubble = sessionEndBubble(Date.now(), finished, settings, memory, world);
        if (bubble) show(bubble);
      }, AFTER_WAKE_MS);
    },
    startRefused() {
      show(openAppBubble());
    },
    toggleMenu(trigger) {
      if (card) {
        closeCard();
        return;
      }
      // The command exists in debug builds only.
      if (import.meta.env.DEV) void invoke("companion_log_menu", { trigger }).catch(() => {});
      openCard(
        (el) => {
          const actions = document.createElement("div");
          actions.className = "parrot-actions";
          const items = [
            button("Quiet 1h", quiet1h),
            button("Quiet today", quietToday),
            button("Hide", hide),
          ];
          // 25 is a one-click start on the dashboard too. 45+ is never offered here.
          if (!world.sessionActive) items.unshift(button("Start 25", start25));
          actions.append(...items);
          el.append(actions);
        },
        "parrot-card parrot-menu",
        MENU_MS,
      );
    },
    rects: () => (card ? [card.getBoundingClientRect()] : []),
  };
}
