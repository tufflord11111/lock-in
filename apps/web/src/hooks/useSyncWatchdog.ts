import { useEffect, useRef } from "react";
import { goOffline, goOnline, onValue, ref } from "firebase/database";
import { auth, db } from "@lock-in/firebase";
import { logUiEvent } from "../uiEventLog";
import { CHECK_MS, WATCHDOG_START, watchdogStep, type WatchdogState } from "../syncWatchdog";

/**
 * Cycles a Realtime Database connection that stays down while its host
 * answers (see syncWatchdog.ts). Signed in only: signed out, nothing is synced.
 */
export function useSyncWatchdog(userId: string | undefined, hostAnswers: boolean): void {
  const hostAnswersRef = useRef(hostAnswers);
  hostAnswersRef.current = hostAnswers;

  useEffect(() => {
    if (!userId) return;
    let connected = false;
    let state: WatchdogState = WATCHDOG_START;
    const off = onValue(ref(db, ".info/connected"), (snap) => {
      connected = snap.val() === true;
    });
    const timer = window.setInterval(() => {
      const step = watchdogStep(state, { connected, hostAnswers: hostAnswersRef.current, now: Date.now() });
      state = step.state;
      if (!step.kick) return;
      console.warn("[LOCK-IN] database not connected for 60 s while its host answers: reconnecting");
      logUiEvent("sync-reconnect", userId);
      goOffline(db);
      goOnline(db);
      auth.currentUser?.getIdToken(true).catch((err) => console.warn("[LOCK-IN] token refresh failed:", err));
    }, CHECK_MS);
    return () => {
      off();
      window.clearInterval(timer);
    };
  }, [userId]);
}
