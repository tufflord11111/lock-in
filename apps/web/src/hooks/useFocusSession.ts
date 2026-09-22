import { db } from "@lock-in/firebase";
import { ref, update, push, serverTimestamp, set, increment, onValue, get } from "firebase/database";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getDeviceId } from "../deviceId";
import { dismissWriteFailure, guardWrite, reportWriteFailure } from "../writeFailures";
import { logUiEvent } from "../uiEventLog";
import { reportEngineFailure } from "../engineHealth";
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

/** How long a session-end write may go unacknowledged before we say so. */
const SESSION_END_ACK_MS = 5000;

/**
 * Tell the operator when the end of a session hasn't reached Firebase.
 *
 * .info/connected is read only to pick the wording, never to decide whether to
 * warn: the SDK's keepalive has no ack timeout, so on a half-open connection
 * (resume from sleep, captive portal) it can report connected for a long time
 * while writes sit in the queue. The missing ack is the signal.
 *
 * The notice is sticky — it stays until the queued write is acknowledged (then
 * it clears itself) or the operator closes it. A timed toast raised while the
 * window was in the background was gone before anyone looked.
 */
function warnIfSessionEndUnsaved(write: Promise<void>, uid: string): void {
  let settled = false;
  let warned = false;
  let toastId: number | null = null;

  const onSettled = (acked: boolean) => {
    settled = true;
    if (warned && acked) logUiEvent("session-end-acked", uid);
    // Acked: the notice is no longer true. Refused: guardWrite shows the error.
    if (toastId !== null) dismissWriteFailure(toastId);
  };
  write.then(
    () => onSettled(true),
    () => onSettled(false)
  );

  setTimeout(() => {
    if (settled) return;
    onValue(
      ref(db, ".info/connected"),
      (snap) => {
        if (settled) return;
        warned = true;
        const connected = snap.val() === true;
        logUiEvent(
          connected ? "session-end-timeout-connected" : "session-end-timeout-offline",
          uid
        );
        toastId = reportWriteFailure(
          connected
            ? "Still saving the end of your session…"
            : "You're offline — your session ended locally but your extension may keep blocking sites until you reconnect.",
          undefined,
          "info",
          { sticky: true }
        );
      },
      { onlyOnce: true }
    );
  }, SESSION_END_ACK_MS);
}

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
  // Wall-clock deadline (epoch ms) of the running session, or null. The
  // countdown is derived from it rather than decremented once per tick:
  // WebView2 throttles — and after ~5 minutes suspends — timers in a hidden or
  // covered window, and Tauri can't turn that off on Windows
  // (backgroundThrottling is unsupported there). A per-tick countdown fell
  // minutes behind the real deadline.
  const endTimeRef = useRef<number | null>(null);
  // True from session start (or adoption) until the session has ended ONCE.
  // The countdown and the Rust deadline can both reach the end; only the
  // first may run endSession.
  const sessionLiveRef = useRef(false);
  // Latest endSession, for listeners and timers that subscribe once.
  const endSessionRef = useRef<(success: boolean) => void>(() => {});

  /** Whole seconds left before the deadline, or null with no session. */
  const secondsRemaining = useCallback((): number | null => {
    if (endTimeRef.current == null) return null;
    return Math.max(0, Math.ceil((endTimeRef.current - Date.now()) / 1000));
  }, []);

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
  // Two mechanisms, both reducing to one idempotent LOCAL reset — with one
  // exception. A disarm or a remote stop must not call endSession: its
  // Firebase writes belong to useDisarmRecovery / the other device, and
  // calling it here would double-log them. But "deadline-expired" IS this
  // session ending on time; Rust simply got there before the webview's
  // throttled countdown. That one runs endSession, or the session-end writes
  // (and the offline notice) would never happen at all.

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
      sessionLiveRef.current = false;
      endTimeRef.current = null;
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
        const reason = event.payload?.reason ?? "unknown";
        if (reason === "deadline-expired" && sessionLiveRef.current) {
          console.info("[LOCK-IN] Rust deadline reached before the UI countdown — ending the session");
          endSessionRef.current(true);
          return;
        }
        if (isActiveRef.current) {
          resetLocalSession(`enforcer-stood-down: ${reason}`);
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
        // Never arm on a session that can't be running: one with no endTime
        // (it would never expire on its own) or one whose endTime has passed
        // (e.g. a phone session that ended offline and was never cleared —
        // every desktop launch used to arm on it). Rust refuses these too.
        if (remoteActive) {
          const end = typeof data.endTime === "number" ? data.endTime : null;
          if (end === null || end <= Date.now()) {
            console.info(
              `[LOCK-IN] ignoring remote session from device ${data.originDeviceId ?? "unknown"} — ${
                end === null ? "it has no endTime" : "its endTime has already passed"
              }`
            );
            return;
          }
        }
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
      // The countdown and the Rust deadline can both get here; end once.
      if (!sessionLiveRef.current) return;
      sessionLiveRef.current = false;

      // STEP 1: Clear timer immediately
      clearTimer();

      // STEP 2: Calculate time spent before resetting — from the wall clock,
      // not the rendered timeLeft, which lags when the window is throttled.
      const remaining = secondsRemaining() ?? timeLeft;
      endTimeRef.current = null;
      const secondsSpent = Math.max(0, initialSecondsRef.current - remaining);
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
        .catch((err) =>
          reportEngineFailure(
            "update_enforcement(stop)",
            "The enforcer didn't confirm the end of your session, so blocked apps may keep closing until its original end time. Restart Lock-In if they do.",
            err
          )
        );

      // STEP 5: Clear chrome storage if available
      if (typeof (window as any).chrome !== 'undefined' 
          && (window as any).chrome.storage) {
        (window as any).chrome.storage.local.set({ timeLeft: null });
      }

      // STEP 6: ONE atomic write for everything the end of a session records —
      // the session flag, the extension's flag, the history entry and the
      // daily minutes. Fired WITHOUT await; the UI is already unfrozen.
      //
      // Atomic so they can never partly land: previously four separate writes,
      // and offline they queued (and could be lost) independently. The history
      // key is generated client-side (push() with no value writes nothing) so
      // it can ride in the same update.
      const updates: Record<string, unknown> = {
        // Whole-node, as the previous set() was: clears endTime, blockedUrls
        // and objective. originDeviceId lets the cross-device mirror skip
        // this write's echo.
        [`users/${userId}/sessionState`]: { isActive: false, originDeviceId: deviceId },
        [`users/${userId}/config/focusActive`]: false,
      };

      // STEP 7: History, only if time was spent.
      if (minutesToLog > 0) {
        setTotalMinutesFocused((prev) => prev + minutesToLog);
        const historyKey = push(ref(db, `users/${userId}/sessionHistory`)).key;
        const today = new Date().toLocaleDateString('en-CA');
        updates[`users/${userId}/sessionHistory/${historyKey}`] = {
          objective: taskLabel,
          minutes: minutesToLog,
          timestamp: serverTimestamp(),
          status: success ? "completed" : "aborted",
        };
        updates[`users/${userId}/history/${today}`] = increment(minutesToLog);
      }

      let write: Promise<void>;
      try {
        write = update(ref(db), updates);
      } catch (err) {
        // update() validates synchronously and throws before returning a
        // promise, which guardWrite would never see.
        reportWriteFailure(
          "Couldn't save the end of your session. Your browser extension may keep blocking sites, and this session's minutes weren't recorded.",
          err
        );
        write = Promise.resolve();
      }

      // A server refusal (PERMISSION_DENIED) still surfaces as an error.
      guardWrite(
        write,
        "Couldn't save the end of your session. Other devices may still show it running, your browser extension may keep blocking sites, and this session's minutes weren't recorded."
      );

      // Offline, the write neither resolves nor rejects — it queues until the
      // connection returns (and is lost if the app closes first), so guardWrite
      // alone says nothing. Race the ack against a timer instead. A connected
      // write acks well under a second. The write stays queued either way.
      warnIfSessionEndUnsaved(write, userId);

      console.log('[SESSION] endSession complete — UI reset, Firebase writes firing');
    },
    [clearTimer, secondsRemaining, setTotalMinutesFocused, taskLabel, timeLeft, updatePresence, userId, deviceId],
  );
  useEffect(() => {
    endSessionRef.current = endSession;
  }, [endSession]);

  /**
   * The 1 s countdown. Factored out of startSession so a session ADOPTED from
   * Rust after a restart ticks exactly like one started here. Assumes timeLeft
   * has already been set. Reaching zero ends the session for real (endSession)
   * — that is the one place the timer is allowed to touch Firebase.
   */
  const startCountdown = useCallback(() => {
    clearTimer();
    intervalRef.current = setInterval(() => {
      // Read the clock, don't count ticks: a throttled tick must land on the
      // right value, not one second on from a stale one.
      const fromClock = secondsRemaining();
      setTimeLeft((prev) => {
        const next = fromClock ?? prev - 1;
        if (typeof (window as any).chrome !== 'undefined' && (window as any).chrome.storage) {
          (window as any).chrome.storage.local.set({ timeLeft: Math.max(0, next) });
        }
        if (next <= 0) {
          if (intervalRef.current !== null) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
          queueMicrotask(() => endSessionRef.current(true));
          return 0;
        }
        return next;
      });
    }, 1000);
  }, [clearTimer, secondsRemaining]);

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

      // Broadcast full session state to Firebase for extension to read.
      //
      // ONE atomic write for sessionState and config/focusActive. They were two
      // separate unguarded writes; if focusActive:true landed without the new
      // sessionState, the extension saw focusActive with the previous session's
      // endTime-less sessionState and blocked indefinitely — and boot
      // reconciliation, which needs sessionState.isActive, could never clear it.
      const endTime = Date.now() + seconds * 1000;
      endTimeRef.current = endTime;
      sessionLiveRef.current = true;
      const startMessage =
        "Couldn't save the start of your session. Your browser extension may not block sites during it, and other devices won't see it running.";
      try {
        guardWrite(
          update(ref(db), {
            [`users/${userId}/sessionState`]: {
              isActive: true,
              endTime,
              objective: label.trim(),
              blockedUrls: masterBlockList,
              originDeviceId: deviceId, // lets the cross-device mirror skip this write's echo
            },
            [`users/${userId}/config/focusActive`]: true,
          }),
          startMessage
        );
      } catch (err) {
        // update() validates synchronously, before guardWrite sees a promise.
        reportWriteFailure(startMessage, err);
      }

      // Signal Rust sniper (exe list only — don't send "youtube.com" to taskkill)
      console.log("REACT: Firing Rust sniper ACTIVE signal...", exeList);
      // endTime travels to Rust so a session that outlives this webview (quit +
      // relaunch) still has a deadline the enforcer can expire it against.
      invoke("update_enforcement", { isActive: true, blockedList: exeList, endTime })
        .then((res) => console.log("RUST RESPONSE:", res))
        .catch((err) =>
          reportEngineFailure(
            "update_enforcement(start)",
            "The enforcer didn't start, so apps won't be blocked this session. Restart Lock-In and start again.",
            err
          )
        );

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
          endTimeRef.current = s.session_end_time;
          sessionLiveRef.current = true;
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

  // (3) RECONCILE — clear a session this device ended but never told Firebase
  // about. Session-end writes made offline only queue in memory; closing the
  // app before reconnecting drops them, leaving config/focusActive:true and
  // sessionState.isActive:true on the server. Rust expires its own copy on
  // restore, but nothing else rewrites the flags, so the Chrome extension kept
  // blocking indefinitely.
  //
  // Only this device's own, provably expired session is cleared:
  //   - originDeviceId === deviceId → endTime came from THIS machine's clock,
  //     so there is no cross-device skew, and another device's live session is
  //     never touched.
  //   - endTime < now → a session with no deadline is left alone.
  //   - isActiveRef → a session started here since boot is never clobbered.
  //     A start made before the snapshot is delivered is also safe: its
  //     optimistic write is already in the local view, so the snapshot shows
  //     the new, unexpired session.
  //
  // onValue(onlyOnce), not get(): get() rejects on an offline boot with nothing
  // cached, whereas onValue waits for the server — so an offline boot still
  // reconciles once the connection comes up.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const unsub = onValue(
      ref(db, `users/${userId}/sessionState`),
      (snap) => {
        if (cancelled) return;
        const s = snap.val();
        if (!s || s.isActive !== true) return;
        if (s.originDeviceId !== deviceId) return;
        if (typeof s.endTime !== "number" || s.endTime >= Date.now()) return;
        if (isActiveRef.current) {
          console.info("[LOCK-IN] reconcile: stale session found, but a local session has started — skipping");
          return;
        }

        console.info("[LOCK-IN] reconcile: clearing a session that ended without reaching Firebase");
        logUiEvent("reconcile-write", userId);
        // One atomic write: the two flags go together or not at all.
        guardWrite(
          update(ref(db), {
            [`users/${userId}/config/focusActive`]: false,
            [`users/${userId}/sessionState/isActive`]: false,
          }),
          "Couldn't clear a session that ended while you were offline. Your browser extension may keep blocking sites."
        );
      },
      (err) => console.warn("[LOCK-IN] reconcile: sessionState read failed:", err),
      { onlyOnce: true }
    );
    return () => {
      cancelled = true;
      unsub();
    };
  }, [userId, deviceId]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  return {
    isActive,
    timeLeft,
    taskLabel,
    startSession,
    endSession,
  };
}


