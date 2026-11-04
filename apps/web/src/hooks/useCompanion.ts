/**
 * The main window's side of the parrot. The overlay has no Firebase and no
 * session code, so it asks for both over events and this hook answers.
 */
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { db } from "@lock-in/firebase";
import { onValue, ref, update } from "firebase/database";
import { DEFAULT_SETTINGS, type Settings } from "../parrot/nextBubble";
import { guardWrite } from "../writeFailures";

const BIRD_START_MINUTES = 25;
const CACHE_KEY = "parrot.settings";
/** First boot on this PC, offline: how long to wait for the account before defaulting to on. */
const FIRST_ANSWER_WAIT_MS = 5_000;

/** A missing `enabled` means on: nothing is written until the user changes something. */
export function readCompanionSettings(raw: unknown): Settings {
  const v = (raw ?? {}) as Partial<Record<keyof Settings, unknown>>;
  const hhmm = (value: unknown, fallback: string) =>
    typeof value === "string" && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value) ? value : fallback;
  return {
    enabled: v.enabled !== false,
    nudgeAfterMin:
      typeof v.nudgeAfterMin === "number" && v.nudgeAfterMin >= 30 && v.nudgeAfterMin <= 240
        ? v.nudgeAfterMin
        : DEFAULT_SETTINGS.nudgeAfterMin,
    quietStart: hhmm(v.quietStart, DEFAULT_SETTINGS.quietStart),
    quietEnd: hhmm(v.quietEnd, DEFAULT_SETTINGS.quietEnd),
  };
}

export function writeCompanionSettings(uid: string, patch: Partial<Settings>) {
  return guardWrite(
    update(ref(db, `users/${uid}/config/companion`), { ...patch, v: 1 }),
    "Couldn't save your parrot settings. The old ones still apply.",
  );
}

/**
 * Keeps the overlay in step with the account: creates it when signed in with the
 * companion on, destroys it otherwise, and answers its questions. Pass a uid only
 * once there is a verified account, so the Login screen never has a bird.
 */
export function useCompanionSettings(uid: string | undefined) {
  const current = useRef<Settings>(DEFAULT_SETTINGS);

  useEffect(() => {
    const stops = [
      listen("companion:hello", () => {
        void emitTo("parrot", "companion:settings", current.current);
      }),
      listen("companion:hide", () => {
        if (latestUid.current) void writeCompanionSettings(latestUid.current, { enabled: false });
      }),
    ];
    return () => {
      for (const stop of stops) void stop.then((off) => off());
    };
  }, []);

  const latestUid = useRef(uid);
  latestUid.current = uid;

  useEffect(() => {
    const apply = (settings: Settings) => {
      current.current = settings;
      void invoke("companion_set_enabled", { enabled: settings.enabled }).catch(() => {});
      void emitTo("parrot", "companion:settings", settings);
    };

    if (!uid) {
      void invoke("companion_set_enabled", { enabled: false }).catch(() => {});
      return;
    }

    // Offline, Firebase may never answer. The last settings on this PC stand in.
    const cached = localStorage.getItem(CACHE_KEY);
    let waiting: number | undefined;
    if (cached !== null) {
      try {
        apply(readCompanionSettings(JSON.parse(cached)));
      } catch {
        apply(DEFAULT_SETTINGS);
      }
    } else {
      waiting = window.setTimeout(() => apply(DEFAULT_SETTINGS), FIRST_ANSWER_WAIT_MS);
    }

    const off = onValue(
      ref(db, `users/${uid}/config/companion`),
      (snap) => {
        window.clearTimeout(waiting);
        const settings = readCompanionSettings(snap.val());
        localStorage.setItem(CACHE_KEY, JSON.stringify(settings));
        apply(settings);
      },
      (err) => console.warn("[LOCK-IN] parrot settings listener error:", err),
    );
    return () => {
      window.clearTimeout(waiting);
      off();
    };
  }, [uid]);
}

/** The Block Registry's view of the same node. */
export function useCompanionSettingsView(uid: string): Settings {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  useEffect(
    () => onValue(ref(db, `users/${uid}/config/companion`), (snap) => setSettings(readCompanionSettings(snap.val()))),
    [uid],
  );
  return settings;
}

/**
 * Start 25 from the bird goes through the same gated start the dashboard uses.
 * It is only ever 25: anything from 45 up has to be held down, on the dashboard.
 */
export function useCompanionStart(options: {
  canStart: boolean;
  start: (minutes: number, label: string) => Promise<void>;
  /** The pre-start question, if the start stopped to ask one. */
  askingFirst: boolean;
}) {
  const { canStart, start, askingFirst } = options;
  const latest = useRef({ canStart, start });
  latest.current = { canStart, start };
  const fromBird = useRef(false);

  useEffect(() => {
    const stop = listen<{ minutes: number }>("companion:start-session", (e) => {
      if (e.payload.minutes !== BIRD_START_MINUTES) return;
      if (!latest.current.canStart) {
        void emitTo("parrot", "companion:start-refused");
        void invoke("companion_show_main");
        return;
      }
      fromBird.current = true;
      void latest.current.start(BIRD_START_MINUTES, "Untitled Session").finally(() => {
        // After React has had time to render the pre-start question, if any.
        window.setTimeout(() => {
          fromBird.current = false;
        }, 500);
      });
    });
    return () => {
      void stop.then((off) => off());
    };
  }, []);

  // That question lives in the main window, which may be hidden in the tray.
  useEffect(() => {
    if (askingFirst && fromBird.current) void invoke("companion_show_main");
  }, [askingFirst]);
}
