/**
 * The main window's side of the parrot. The overlay has no Firebase and no
 * session code, so it asks for both over events and this hook answers.
 */
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { db } from "@lock-in/firebase";
import { onValue, ref, update } from "firebase/database";
import { guardWrite } from "../writeFailures";

const BIRD_START_MINUTES = 25;

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
