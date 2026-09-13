import { db } from "@lock-in/firebase";
import { ref, update, push, serverTimestamp, set, increment, onValue, get } from "firebase/database";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getDeviceId } from "../deviceId";
import type { EnforcerState } from "../components/EnforcerDisarmPanel";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

export function useFocusSession(
  userId: string | undefined,
  setTotalMinutesFocused: Dispatch<SetStateAction<number>>,
  blockedApps: string[] = [],
  blockedWebsites: string[] = [],
  updatePresence?: (state: "online" | "offline" | "locked-in") => Promise<void>
) {
  const [isActive, setIsActive] = useState(false);
  const [timeLeft, setTimeLeft] = useState(0);
  const [taskLabel, setTaskLabel] = useState("");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const totalMinutesRef = useRef(0);
  const initialSecondsRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // ── Rust is the truth; the session UI follows it ──────────────────────────
  // isActive/timeLeft are React-local and used to be reconciled with Rust
  // NOWHERE. App never unmounts across sign-out, so a countdown started before
  // signing out kept ticking through a Login-screen emergency disarm and the
  // Dashboard showed SESSION ACTIVE while nothing was being enforced.
  //
  // Two mechanisms, both reducing to one idempotent LOCAL reset. Neither calls
  // endSession — its Firebase writes and history entry belong to
  // useDisarmRecovery, and calling it here would double-log the disarm.

  // Mirrored so the listeners below read the live value without re-subscribing
  // on every session start/stop.
  const isActiveRef = useRef(isActive);
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  /** Local-only stand-down. Idempotent: every step is a no-op when already reset. */
  const resetLocalSession = useCallback(
    (reason: string) => {
      console.info(`[LOCK-IN] session UI reset to match Rust (${reason})`);
      clearTimer();
      totalMinutesRef.current = 0;
      initialSecondsRef.current = 0;
      setIsActive(false);
      setTimeLeft(0);
      setTaskLabel("");
      if (typeof (window as any).chrome !== "undefined" && (window as any).chrome.storage) {
        (window as any).chrome.storage.local.set({ timeLeft: null });
      }
    },
    [clearTimer]
  );

  // When Rust last stood down, by our clock. The adopt path below compares
  // this against the moment its probe was SENT: a probe answered "armed"
  // before a stand-down event landed is a stale snapshot and must not adopt.
  const lastStoodDownRef = useRef(0);

  // (1) PUSH — Rust emits "enforcer-stood-down" on EVERY focus_active
  // true→false transition: emergency disarm, local/remote session end,
  // deadline expiry, restore-time stand-downs. Payload carries the reason.
  useEffect(() => {
    const unlisten = listen<{ reason: string; retained_targets: number }>(
      "enforcer-stood-down",
      (event) => {
        lastStoodDownRef.current = Date.now();
        if (isActiveRef.current) {
          resetLocalSession(`enforcer-stood-down: ${event.payload?.reason ?? "unknown"}`);
        }
      }
    );
    return () => {
      unlisten.then((f) => f());
    };
  }, [resetLocalSession]);

  // (2) PULL lives below startSession — it needs startCountdown, which is
  // declared there, and a hook's deps array is evaluated in source order.

  // sync_blocklist now lives in App.tsx, which owns the blockedApps + origin
  // metadata needed to auto-approve this device's own entries (H1).

  // Kept in a ref so the sessionState listener below can read the current
  // blocklist without resubscribing every time Firebase pushes a new array.
  const blockedAppsRef = useRef<string[]>(blockedApps);
  useEffect(() => {
    blockedAppsRef.current = blockedApps;
  }, [blockedApps]);

  // Stable per-install id, shared with useOmniSync. Stamped onto every
  // sessionState write so the mirror can recognise — and ignore — its own.
  const deviceId = useMemo(getDeviceId, []);

  // ── Cross-device session mirror ───────────────────────────────────────────
  // update_enforcement is the single owner of arming, so a session started on
  // another machine reaches this one through here. Two rules keep it from
  // fighting the local session flow:
  //
  //   1. ORIGIN — Firebase raises onValue on the WRITING client immediately,
  //      before the server ack, so every local start/stop would echo straight
  //      back here. Payloads stamped with this device's id are ignored. This
  //      is an identity check, not a timing assumption.
  //   2. INITIAL PAYLOAD IS ARM-ONLY — the first payload after subscribing
  //      is the current state, not a transition. It may ARM (this device
  //      booted while a session is live on another) but may never DISARM:
  //      acting on a mount-time {isActive:false} is what used to stand the
  //      enforcer down on every boot. Restoring local state is Rust's job
  //      (restore_profile), not this listener's.
  //
  // fromRemote:true means the call may not lift the disarm latch and is
  // refused outright while the latch is set.
  useEffect(() => {
    if (!userId) return;
    // Per-subscription, so a re-subscribe (login/logout) skips its own
    // initial payload too.
    let seenInitialPayload = false;
    const sessRef = ref(db, `users/${userId}/sessionState`);
    const unsub = onValue(
      sessRef,
      (snap) => {
        const isInitialPayload = !seenInitialPayload;
        seenInitialPayload = true;

        const data = snap.val();
        if (!data) return;
        // Origin check runs BEFORE the initial-payload gate, so a boot-time
        // payload this device wrote itself is dropped like any other echo.
        if (data.originDeviceId === deviceId) return; // our own echo

        const remoteActive = data.isActive === true;
        // Initial payload may arm but never disarm (see rule 2 above).
        if (isInitialPayload && !remoteActive) return;
        const exeList = blockedAppsRef.current.filter(
          (b) => b.endsWith(".exe") || !b.includes(".")
        );
        console.info(
          `[LOCK-IN] remote session ${remoteActive ? "START" : "STOP"} from device ${
            data.originDeviceId ?? "unknown"
          }`
        );
        invoke("update_enforcement", {
          isActive: remoteActive,
          blockedList: remoteActive ? exeList : [],
          endTime: remoteActive ? (data.endTime ?? null) : null,
          fromRemote: true,
        }).catch((err) =>
          console.warn("[Enforcer] remote session mirror failed:", err)
        );
      },
      (err) => console.error("[LOCK-IN] sessionState listener error:", err)
    );
    return () => unsub();
  }, [userId, deviceId]);

  const endSession = useCallback(
    async (success: boolean) => {
      if (!userId) return;

      // STEP 1: Clear timer immediately
      clearTimer();

      // STEP 2: Calculate time spent before resetting
      const secondsSpent = initialSecondsRef.current - timeLeft;
      const minutesToLog = Math.ceil(secondsSpent / 60);

      // STEP 3: Reset ALL UI state immediately
      // This happens synchronously — UI unfreezes NOW
      totalMinutesRef.current = 0;
      initialSecondsRef.current = 0;
      setIsActive(false);
      setTimeLeft(0);
      setTaskLabel("");
      if (updatePresence) {
        updatePresence("online");
      }

      // STEP 4: Signal Rust to stand down (already fire-and-forget)
      invoke("update_enforcement", { isActive: false, blockedList: [], endTime: null })
        .then((res) => console.log("[Enforcer] Stand-down confirmed:", res))
        .catch((err) => console.warn("[Enforcer] failed:", err));

      // STEP 5: Clear chrome storage if available
      if (typeof (window as any).chrome !== 'undefined' 
          && (window as any).chrome.storage) {
        (window as any).chrome.storage.local.set({ timeLeft: null });
      }

      // STEP 6: Fire all Firebase writes WITHOUT await
      // These complete in background — UI is already unfrozen
      const sessionStateRef = ref(db, `users/${userId}/sessionState`);
      // originDeviceId lets the cross-device mirror skip this write's echo.
      set(sessionStateRef, { isActive: false, originDeviceId: deviceId })
        .catch(err => console.error('[SESSION] sessionState write failed:', err));

      const configRef = ref(db, `users/${userId}/config`);
      update(configRef, { focusActive: false })
        .catch(err => console.error('[SESSION] config write failed:', err));

      // STEP 7: Log session history in background (only if time was spent)
      if (minutesToLog > 0) {
        setTotalMinutesFocused((prev) => prev + minutesToLog);

        const historyRef = ref(db, `users/${userId}/sessionHistory`);
        push(historyRef, {
          objective: taskLabel,
          minutes: minutesToLog,
          timestamp: serverTimestamp(),
          status: success ? "completed" : "aborted"
        }).catch(err => console.error('[SESSION] history write failed:', err));

        try {
          const today = new Date().toLocaleDateString('en-CA');
          const dailyHistoryRef = ref(db, `users/${userId}/history`);
          update(dailyHistoryRef, {
            [today]: increment(minutesToLog)
          }).catch(err => console.error('[SESSION] daily history failed:', err));
        } catch (err) {
          console.error("[useFocusSession] Failed to increment daily history:", err);
        }
      }

      console.log('[SESSION] endSession complete — UI reset, Firebase writes firing');
    },
    [clearTimer, setTotalMinutesFocused, taskLabel, timeLeft, updatePresence, userId, deviceId],
  );

  /**
   * The 1 s countdown. Factored out of startSession so a session ADOPTED from
   * Rust after a restart ticks exactly like one started here. Assumes timeLeft
   * has already been set. Reaching zero ends the session for real (endSession)
   * — that is the one place the timer is allowed to touch Firebase.
   */
  const startCountdown = useCallback(() => {
    clearTimer();
    intervalRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        const next = prev - 1;
        if (typeof (window as any).chrome !== 'undefined' && (window as any).chrome.storage) {
          (window as any).chrome.storage.local.set({ timeLeft: Math.max(0, next) });
        }
        if (next <= 0) {
          if (intervalRef.current !== null) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
          queueMicrotask(() => endSession(true));
          return 0;
        }
        return next;
      });
    }, 1000);
  }, [clearTimer, endSession]);

  const startSession = useCallback(
    (minutes: number, label: string) => {
      if (!userId) return;
      clearTimer();
      const seconds = Math.max(0, Math.floor(minutes * 60));
      if (seconds === 0) return;

      totalMinutesRef.current = minutes;
      initialSecondsRef.current = seconds;
      setTaskLabel(label.trim());
      setTimeLeft(seconds);
      setIsActive(true);

      // ── Build split payloads ────────────────────────────────────────
      // exeList  → Rust sniper (process names only)
      // masterBlockList → Firebase → Chrome Extension (websites + exe names)
      const exeList = blockedApps.filter(b => b.endsWith(".exe") || !b.includes("."));
      console.log('[Session] blockedApps received:', blockedApps);
      console.log('[Session] exeList after filter:', exeList);
      
      const masterBlockList = [
        ...blockedWebsites,
        ...blockedApps,
      ];

      // Broadcast full session state to Firebase for extension to read
      const endTime = Date.now() + seconds * 1000;
      const sessionStateRef = ref(db, `users/${userId}/sessionState`);
      set(sessionStateRef, {
        isActive: true,
        endTime,
        objective: label.trim(),
        blockedUrls: masterBlockList,
        originDeviceId: deviceId, // lets the cross-device mirror skip this write's echo
      });

      // Signal Rust sniper (exe list only — don't send "youtube.com" to taskkill)
      console.log("REACT: Firing Rust sniper ACTIVE signal...", exeList);
      // endTime travels to Rust so a session that outlives this webview (quit +
      // relaunch) still has a deadline the enforcer can expire it against.
      invoke("update_enforcement", { isActive: true, blockedList: exeList, endTime })
        .then((res) => console.log("RUST RESPONSE:", res))
        .catch((err) => console.warn("[Enforcer] update_enforcement(start) — not in Tauri or failed:", err));

      const configRef = ref(db, `users/${userId}/config`);
      update(configRef, { focusActive: true });

      startCountdown();

      if (updatePresence) {
        updatePresence("locked-in");
      }
    },
    [clearTimer, endSession, startCountdown, blockedApps, blockedWebsites, updatePresence, userId, deviceId],
  );

  // (2) PULL — on every userId transition, ask Rust and reconcile BOTH ways.
  //   React active, Rust idle   → RESET  (stale countdown after a stand-down)
  //   React idle,   Rust active → ADOPT  (restart mid-session: Rust restored
  //                                       the session from disk, React booted
  //                                       blank and would show the Dashboard
  //                                       idle while apps are being killed)
  // The two branches are mutually exclusive on one probe; they cannot fight.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const probeSentAt = Date.now();

    invoke<EnforcerState>("get_enforcer_state")
      .then((s) => {
        if (cancelled) return;

        if (isActiveRef.current && !s.focus_active) {
          resetLocalSession("auth-transition probe: Rust focus_active=false");
          return;
        }

        if (!isActiveRef.current && s.focus_active && s.session_end_time != null) {
          // A stand-down event that landed AFTER this probe was sent means the
          // "armed" answer is a stale snapshot. Rust's current truth is idle.
          if (lastStoodDownRef.current > probeSentAt) {
            console.info("[LOCK-IN] not adopting — Rust stood down after the probe was sent");
            return;
          }
          const remaining = Math.floor((s.session_end_time - Date.now()) / 1000);
          if (remaining <= 0) {
            // Past its deadline. Rust's own expiry stands it down on the next
            // tick; adopting would show a session about to vanish.
            console.info("[LOCK-IN] not adopting — restored session already expired");
            return;
          }

          console.info(`[LOCK-IN] adopting restored session from Rust — ${remaining}s remaining`);
          // Minutes logged at the end are counted from adoption, not from the
          // original start — the pre-restart portion was never observed here.
          totalMinutesRef.current = Math.ceil(remaining / 60);
          initialSecondsRef.current = remaining;
          setTaskLabel("Untitled Session");
          setTimeLeft(remaining);
          setIsActive(true);
          startCountdown();
          if (updatePresence) updatePresence("locked-in");

          // The objective lives in Firebase, not Rust. Best-effort and
          // non-blocking — adoption must not wait on the network.
          get(ref(db, `users/${userId}/sessionState/objective`))
            .then((snap) => {
              const label = snap.val();
              if (!cancelled && typeof label === "string" && label.trim()) {
                setTaskLabel(label);
              }
            })
            .catch(() => {});
        }
      })
      .catch((err) => console.warn("[LOCK-IN] session/Rust reconcile probe failed:", err));

    return () => {
      cancelled = true;
    };
  }, [userId, resetLocalSession, startCountdown, updatePresence]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  return {
    isActive,
    timeLeft,
    taskLabel,
    startSession,
    endSession,
  };
}


