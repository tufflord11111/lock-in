import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion, AnimatePresence } from "framer-motion";
import { db } from "@lock-in/firebase";
import { ref, onValue, update } from "firebase/database";
import { BottomNav, type AppTab } from "./components/BottomNav";
import { X } from "lucide-react";
import { useFocusSession } from "./hooks/useFocusSession";
import { useOmniSync } from "./hooks/useOmniSync";
import { usePresence } from "./hooks/usePresence";
import { PerformanceLog as Analytics } from "./screens/PerformanceLog";
import { Dashboard } from "./screens/Dashboard";
import { BlockRegistry } from "./screens/BlockRegistry";
import { KillFeed } from "./components/KillFeed";
import WelcomeSequence from "./components/WelcomeSequence";
import { VerificationGate } from "./components/VerificationGate";
import { EnforcerDisarmPanel } from "./components/EnforcerDisarmPanel";
import { PendingPermanentBanner } from "./components/PendingPermanentBanner";
import { UpdateBanner } from "./components/UpdateBanner";

import { ThePack } from "./screens/ThePack";
import { useAuth } from "./hooks/useAuth";
import { useHandleProfile, reserveHandle, asHandleError, HandleTakenError } from "./hooks/useHandleProfile";
import { ThemeProvider, useTheme, useAccountTheme, useThemeToken, THEMES } from "./theme/ThemeProvider";
import { useCopy, daypart, weekday } from "./theme/copy";
import { useLockInStats } from "./hooks/useLockInStats";
import { useSnapshotWriter } from "./hooks/useSnapshotWriter";
import { useReachable } from "./hooks/useReachable";
import { bootSnapshot } from "./snapshot";
import { BaselineQuestion, hasBeenAsked } from "./components/BaselineQuestion";
import { useDisarmRecovery } from "./hooks/useDisarmRecovery";
import { getDeviceId } from "./deviceId";
import { guardWrite } from "./writeFailures";
import { WriteFailureToasts } from "./components/WriteFailureToasts";
import { awaitWriteOrQueue } from "./offlineWrite";
import { reportEngineFailure } from "./engineHealth";
import { Login } from "./screens/Login";

type ConnectionGateProps = {
  userId?: string;
  engineOffline: boolean;
};

function ConnectionGate({ userId, engineOffline }: ConnectionGateProps) {
  const [extensionStale, setExtensionStale] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!userId) return;
    const heartbeatRef = ref(db, `users/${userId}/extension_state/last_seen`);
    const unsub = onValue(heartbeatRef, (snapshot) => {
      const lastSeen = snapshot.val();
      if (!lastSeen) {
        setExtensionStale(true);
      } else {
        const diff = Date.now() - lastSeen;
        setExtensionStale(diff > 300000);
      }
    });

    return () => unsub();
  }, [userId]);

  if (dismissed) return null;
  if (!extensionStale && !engineOffline) return null;

  let message = "";
  if (extensionStale && engineOffline) {
    message = "⚠ System engine offline & Web Guard not detected — restart Lock-In and ensure Chrome extension is active";
  } else if (extensionStale) {
    message = "⚠ Web Guard not detected — open Chrome and ensure Lock-In extension is active";
  } else if (engineOffline) {
    message = "⚠ System engine offline — restart Lock-In to restore full blocking";
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -20 }}
        className="w-full h-12 bg-highlight-2 text-ink-2 flex items-center justify-between px-6 z-30 shrink-0 font-mono text-xs font-bold shadow-[0_4px_0px_rgb(var(--ink-2-rgb)/0.1)]"
      >
        <span className="flex-1 text-center truncate pr-4">{message}</span>
        <button
          onClick={() => setDismissed(true)}
          className="hover:bg-ink-2/10 p-1 rounded transition-colors"
        >
          <X size={16} />
        </button>
      </motion.div>
    </AnimatePresence>
  );
}

/** Rust-side enforcer truth. serde serializes these field names as declared (snake_case). */
/**
 * Offline/degraded boot screen.
 *
 * The disarm control itself lives in EnforcerDisarmPanel, shared with the
 * Login screen — in practice a broken login lands on Login, not here, and the
 * enforcer keeps running throughout. failOpen is correct on THIS screen: a
 * trapped operator with no button is worse than a spare button.
 */
function DegradedScreen({
  authDegraded,
  onForceOffline,
}: {
  authDegraded: boolean;
  onForceOffline: () => void;
}) {
  return (
    <div className="w-screen h-screen bg-ground flex items-center justify-center">
      <div className="flex flex-col items-center gap-6 px-8 text-center">
        <div className="w-12 h-12 border-2 border-ink/20 border-t-ink rounded-full animate-spin" />
        <div className="flex flex-col gap-2">
          <span className="text-[11px] font-black label-sm text-ink">
            Network Initializing...
          </span>
          <span className="text-[10px] font-bold text-ink/40 label-plain tracking-wide">
            Waiting for connection. The app will load automatically.
          </span>
        </div>

        <div className="flex flex-col gap-3 w-full max-w-xs">
          <button
            onClick={() => window.location.reload()}
            className="px-6 py-3 bg-ink text-surface-inverse font-black text-[10px] label-action-sm rounded-lg border-1 border-ink shadow-[shadow:var(--shadow-1)] hover:-translate-y-0.5 hover:shadow-[shadow:var(--shadow-2)] active:translate-y-0 active:shadow-none transition-all"
          >
            Retry Connection
          </button>

          {authDegraded && (
            <button
              onClick={onForceOffline}
              className="px-6 py-3 bg-transparent text-ink/50 font-black text-[10px] label-action-sm rounded-lg border-1 border-ink/20 hover:border-ink/50 hover:text-ink transition-all"
            >
              Continue Offline
            </button>
          )}

          <EnforcerDisarmPanel failOpen variant="inline" />
        </div>
      </div>
    </div>
  );
}

function AppInner() {
  const {
    user,
    loading,
    emailVerified,
    isNewUser,
    authDegraded,
    verificationSendFailed,
    clearNewUserFlag,
    login,
    register,
    logout,
    reloadUser,
    resendVerificationEmail,
    sendPasswordResetEmail,
    forceOfflineMode,
  } = useAuth();
  const [currentTab, setCurrentTab] = useState<AppTab>("home");
  const { theme, setTheme } = useTheme();
  const t = useCopy();
  /* Botanical replaces the header strip with a full-width band. The token is
     only set by that theme, so everywhere else this is the empty string. */
  const headerBand = useThemeToken("--header-band", "");
  useAccountTheme(user?.uid);
  // Test-only UI, gated on a DEV_MODE file in the app data dir (see Rust
  // is_dev_mode). Outside Tauri the invoke fails and it stays off.
  const [devMode, setDevMode] = useState(false);
  // Ctrl+Shift+T cycles themes so every screen can be checked quickly.
  // Test-only: without the DEV_MODE file the listener is never attached.
  useEffect(() => {
    if (!devMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "T" || e.key === "t")) {
        e.preventDefault();
        const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
        console.info(`[LOCK-IN] dev theme switch -> ${next}`);
        setTheme(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [devMode, theme, setTheme]);

  useEffect(() => {
    invoke<boolean>("is_dev_mode")
      .then((on) => setDevMode(on === true))
      .catch(() => setDevMode(false));
  }, []);
  const [totalMinutesFocused, setTotalMinutesFocused] = useState(0);
  const [usernameInput, setUsernameInput] = useState("");
  const [usernameError, setUsernameError] = useState("");
  const [usernameSubmitting, setUsernameSubmitting] = useState(false);
  /**
   * The baseline question, asked once per machine — at the end of onboarding
   * for new operators, on the next launch for everyone already here.
   */
  const [baselineDone, setBaselineDone] = useState(() => hasBeenAsked());
  /**
   * Read from DB once after email verification.
   * If true, the operator has already completed onboarding — skip WelcomeSequence.
   * null = still loading from DB (show nothing until resolved).
   */
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(null);

  // Name and handle come from config/ — where registration writes them — via
  // useHandleProfile, which also migrates legacy top-level handles and repairs
  // names the old launch-time sync overwrote with "Operator".
  const profile = useHandleProfile(user?.uid, emailVerified);
  // Display placeholder only. It is never written to the database.
  const userName = profile.userName ?? "Operator";

  // One-time read of onboardingComplete flag — drives WelcomeSequence gate
  useEffect(() => {
    if (!user?.uid || !emailVerified) return;
    const flagRef = ref(db, `users/${user.uid}/config/onboardingComplete`);
    const unsub = onValue(
      flagRef,
      (snapshot) => { setOnboardingComplete(snapshot.val() === true); },
      (err) => console.error('[LOCK-IN] onboardingComplete listener error:', err),
      { onlyOnce: true }
    );
    return () => unsub();
  }, [user?.uid, emailVerified]);

  // Default website blocklist — must match extension's STATIC_BLACKLIST
  const WEB_BLOCKLIST = [
    "youtube.com", "tiktok.com", "netflix.com",
    "facebook.com", "instagram.com", "twitter.com",
    "reddit.com", "twitch.tv",
  ];

  // Functional To-Do List State with Persistence
  const [intentions, setIntentions] = useState<{id: string, text: string, completed: boolean}[]>(() => {
    const saved = localStorage.getItem("lockin_intentions");
    return saved ? JSON.parse(saved) : [];
  });

  useEffect(() => {
    localStorage.setItem("lockin_intentions", JSON.stringify(intentions));
  }, [intentions]);

  // Keep public/userName (what friends see) equal to config/userName.
  //
  // This used to run on every launch with userName initialised to "Operator"
  // and write it over config/ and public/ before anything had loaded — which
  // is how every account's name became "Operator". It now waits for the real
  // value from config/ and only mirrors it; config/ itself is written only by
  // registration and the handle reservation, never from here.
  useEffect(() => {
    if (!user?.uid || profile.userName == null) return;
    guardWrite(
      update(ref(db), { [`users/${user.uid}/public/userName`]: profile.userName }),
      "Couldn't update the name your friends see. They may still see your old name."
    );
  }, [profile.userName, user?.uid]);

  // Stable per-install id — same one sessionState uses. Stamped onto every
  // blockedApps entry this device creates, so the enforcer can auto-approve
  // our own blocks (H1) and only stage entries added elsewhere.
  const deviceId = useMemo(getDeviceId, []);

  // Sync blockedApps for Rust process killer.
  const stats = useLockInStats(user?.uid);
  useSnapshotWriter(user?.uid);
  const { reachable } = useReachable();
  const [blockedApps, setBlockedApps] = useState<string[]>(() => bootSnapshot()?.blockedApps ?? []);
  // Raw {key: exe} and the parallel {key: originDeviceId} map, needed to tell
  // Rust which entries this device vouches for.
  const [blockedAppsRaw, setBlockedAppsRaw] = useState<Record<string, string>>({});
  const [blockedAppsMeta, setBlockedAppsMeta] = useState<Record<string, string>>({});
  // False until the blockedApps listener has fired at least once. An empty
  // blockedApps array is ambiguous — "no blocks configured" or "Firebase hasn't
  // answered yet" — so this distinguishes them for the start-button advisory.
  // A snapshot IS hydrated state: the enforcer already has this list on disk,
  // so the "syncing" advisory would be telling the operator a falsehood.
  const [blocklistHydrated, setBlocklistHydrated] = useState(() => !!bootSnapshot()?.uid);
  useEffect(() => {
    if (!user?.uid) return;
    const unsubApps = onValue(
      ref(db, `users/${user.uid}/blockedApps`),
      (snap) => {
        const data = (snap.val() as Record<string, string>) || {};
        setBlockedAppsRaw(data);
        setBlockedApps(Object.values(data).filter((v) => typeof v === "string"));
        setBlocklistHydrated(true);
      },
      (err) => console.error('[LOCK-IN] blockedApps listener error:', err)
    );
    const unsubMeta = onValue(
      ref(db, `users/${user.uid}/blockedApps_meta`),
      (snap) => setBlockedAppsMeta((snap.val() as Record<string, string>) || {}),
      (err) => console.error('[LOCK-IN] blockedApps_meta listener error:', err)
    );
    return () => {
      unsubApps();
      unsubMeta();
    };
  }, [user?.uid]);

  // H1/H2: push blockedApps to the enforcer with an approved subset.
  //   H1 — entries stamped with THIS device's origin auto-approve.
  //   H2 — on the first run after upgrade (per-device localStorage flag) the
  //        whole existing set is approved, so nobody's blocks stage as pending.
  // Everything else (added from another device, or absent origin post-upgrade)
  // is left for Rust to stage behind the approval banner.
  const exeMigratedRef = useRef<boolean>(
    (() => {
      try {
        return localStorage.getItem("lockin_exe_migrated_v1") === "1";
      } catch {
        return false;
      }
    })()
  );
  useEffect(() => {
    if (!user?.uid || !blocklistHydrated) return;
    const entries = Object.entries(blockedAppsRaw);
    const allValues = entries.map(([, v]) => v);
    let approved: string[];
    if (!exeMigratedRef.current) {
      // First hydrated sync after upgrade — trust the current set as-is.
      approved = allValues;
      exeMigratedRef.current = true;
      try {
        localStorage.setItem("lockin_exe_migrated_v1", "1");
      } catch {
        /* private mode — falls back to origin-only next run, one approval */
      }
    } else {
      approved = entries
        .filter(([key]) => blockedAppsMeta[key] === deviceId)
        .map(([, v]) => v);
    }
    invoke("sync_blocklist", {
      blockedList: allValues,
      approvedList: approved,
      fromRemote: true,
    }).catch((err) =>
      reportEngineFailure(
        "sync_blocklist",
        "Your blocked apps didn't reach the enforcer, so recent changes may not apply. Restart Lock-In.",
        err
      )
    );
  }, [user?.uid, blocklistHydrated, blockedAppsRaw, blockedAppsMeta, deviceId]);

  // Sync permanentExe from Firebase to Rust enforcer
  useEffect(() => {
    if (!user?.uid) return;
    const permRef = ref(db, `users/${user.uid}/permanentExe`);
    const unsub = onValue(
      permRef,
      (snap) => {
        const data = snap.val();
        const list: string[] = data
          ? (Object.values(data) as string[]).filter(v => typeof v === 'string')
          : [];
        // fromRemote: this is a Firebase-driven sync, so Rust stages any NEW
        // permanent block for local approval (F4) instead of enforcing it.
        invoke('sync_permanent_exe', { blockedList: list, fromRemote: true }).catch((err) =>
          reportEngineFailure(
            "sync_permanent_exe",
            "Your permanent blocks didn't reach the enforcer, so recent changes may not apply. Restart Lock-In.",
            err
          )
        );
      },
      (err) => console.error('[LOCK-IN] permanentExe listener error:', err)
    );
    return () => unsub();
  }, [user?.uid]);

  const handleAddExe = async (exe: string) => {
    if (!user?.uid) return;
    const key = exe.replace(/\./g, "_");
    // Stamp this device as the origin so the enforcer auto-approves it (H1).
    // Raced: offline, the confirm dialog that awaits this used to stay busy
    // forever. It now closes after 5 s and the write stays queued.
    await awaitWriteOrQueue(
      update(ref(db), {
        [`users/${user.uid}/blockedApps/${key}`]: exe,
        [`users/${user.uid}/blockedApps_meta/${key}`]: deviceId,
      }),
      { lateErrorMessage: `Couldn't save ${exe} to your blocks — it was refused, so it isn't blocked.` }
    );
  };

  // Fire-and-forget through guardWrite: it's called straight from a button,
  // so a refusal used to be an uncaught rejection and nothing on screen.
  const handleRemoveExe = async (exe: string) => {
    if (!user?.uid) return;
    const key = exe.replace(/\./g, "_");
    guardWrite(
      update(ref(db), {
        [`users/${user.uid}/blockedApps/${key}`]: null,
        [`users/${user.uid}/blockedApps_meta/${key}`]: null,
      }),
      `Couldn't remove ${exe}. It's still blocked.`
    );
  };

  const handleUsernameSubmit = useCallback(async () => {
    if (!user?.uid) return;
    setUsernameError("");
    profile.clearHandleError();
    // Validated exactly as registration validates, then claimed atomically:
    // config/ + public/ + usernames/{handle} land together or not at all, so
    // a handle is never written anywhere without its reservation.
    let write: Promise<void>;
    try {
      write = reserveHandle(user.uid, usernameInput);
    } catch (err) {
      setUsernameError((err as Error).message);
      return;
    }
    const showHandleError = (err: unknown) => {
      const e = asHandleError(err);
      setUsernameError(e instanceof HandleTakenError ? e.message : "Failed to save. Try again.");
    };
    setUsernameSubmitting(true);
    try {
      // Raced: offline, "Locking In..." used to spin forever. After 5 s the
      // overlay closes on the local write. If the server later refuses the
      // handle, the SDK reverts that local write, config/usernameSet flips back
      // to false, and the overlay reopens with the taken-handle message.
      await awaitWriteOrQueue(write, {
        lateErrorMessage: "That handle is taken — pick another",
        onLateError: showHandleError,
      });
    } catch (err) {
      showHandleError(err);
    } finally {
      setUsernameSubmitting(false);
    }
  }, [usernameInput, user?.uid, profile.clearHandleError]);

  const {
    totalMinutesToday,
    updateAutostart,
    isSyncing,
    engineOffline
  } = useOmniSync(
    user?.uid,
    totalMinutesFocused,
    setTotalMinutesFocused
  );
  
  const { updatePresence } = usePresence(user?.uid);

  // Clears stale session flags left behind by an emergency disarm, then
  // releases the Rust latch. Runs once per boot, on first successful auth.
  useDisarmRecovery(user?.uid);

  const { isActive, timeLeft, taskLabel, startSession, endSession } = useFocusSession(
    user?.uid,
    setTotalMinutesFocused,
    blockedApps,
    WEB_BLOCKLIST,
    updatePresence
  );

  // Global Timer Formatter
  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  // Safety-net: 8 s hard ceiling — dep array [] so the timer is set once and never
  // cancelled early by a loading->false transition (the old [loading] dep bug).
  const [loadingTimedOut, setLoadingTimedOut] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      console.warn('[LOCK-IN] Loading screen 8 s hard ceiling — showing offline UI');
      setLoadingTimedOut(true);
    }, 8000);
    return () => clearTimeout(t);
  }, []);

  if (loading) {
    if (loadingTimedOut || authDegraded) {
      return (
        <DegradedScreen
          authDegraded={authDegraded}
          onForceOffline={forceOfflineMode}
        />
      );
    }
    return (
      <div className="w-screen h-screen bg-ground flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-2 border-ink border-t-transparent rounded-full animate-spin" />
          <span className="text-[10px] font-black label-sm text-ink/40 italic">
            Syncing Cockpit...
          </span>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <>
        <Login onLogin={login} onRegister={register} onForgotPassword={sendPasswordResetEmail} />
        {/* The delete-account fallback signs out and then needs to explain
            itself, so the toast host lives on this side of the gate too. */}
        <WriteFailureToasts />
      </>
    );
  }

  // ── EMAIL VERIFICATION GATE ─────────────────────────────────────────────
  // User is authenticated but hasn't clicked the verification link yet.
  // Nothing beyond this point renders until emailVerified is true.
  if (!emailVerified) {
    return (
      <VerificationGate
        email={user.email ?? ""}
        onCheckStatus={reloadUser}
        onResend={resendVerificationEmail}
        onLogout={logout}
        sendFailed={verificationSendFailed}
      />
    );
  }

  return (
    <div
      className="relative w-screen h-screen m-0 p-0 box-border bg-ground text-ink overflow-hidden flex flex-col font-sans"
      /* The paper texture belongs to the app shell: the shell is opaque, so a
         texture on <body> would never be seen. Themes without one set none. */
      style={{ backgroundImage: "var(--grid-image)", backgroundSize: "var(--grid-size)" }}
    >
      {/* NEW USER ONBOARDING SEQUENCE */}
      {/* Show when: isNewUser flag is set OR onboardingComplete is explicitly false (fresh DB entry) */}
      <AnimatePresence>
        {(isNewUser || onboardingComplete === false) && (
          <WelcomeSequence
            userName={userName}
            userId={user.uid}
            onComplete={() => {
              clearNewUserFlag();
              setOnboardingComplete(true);
            }}
          />
        )}
      </AnimatePresence>

      {/* USERNAME SETUP GATE */}
      <AnimatePresence>
        {onboardingComplete === true &&
          profile.usernameSet !== false &&
          !baselineDone &&
          !isActive && (
            <BaselineQuestion userId={user.uid} onDone={() => setBaselineDone(true)} />
          )}

        {onboardingComplete === true && profile.status === "ready" && profile.usernameSet === false && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[200] bg-ground flex items-center justify-center"
          >
            <div className="w-full max-w-md flex flex-col items-center gap-8 px-8">
              {t("handle.eyebrow") && (
                <p className="text-[10px] font-black label-plain tracking-[0.4em] text-ink/30">{t("handle.eyebrow")}</p>
              )}
              <div className="text-center">
                <h1 className="text-5xl font-black text-ink label-plain tracking-tight mb-3">{t("handle.title")}</h1>
                <p className="text-xs font-bold text-ink/40 label-plain tracking-wider">{t("handle.sub")}</p>
              </div>
              <div className="w-full flex flex-col gap-3">
                <input
                  type="text"
                  maxLength={20}
                  value={usernameInput}
                  onChange={(e) => {
                    const v = e.target.value.toUpperCase();
                    setUsernameInput(v);
                    profile.clearHandleError();
                    if (v && !/^[A-Za-z0-9_]+$/.test(v)) {
                      setUsernameError("Only letters, numbers, and underscores allowed.");
                    } else {
                      setUsernameError("");
                    }
                  }}
                  onKeyDown={(e) => e.key === "Enter" && handleUsernameSubmit()}
                  placeholder="e.g. IRONCLAD"
                  className="w-full bg-surface border-1 border-ink shadow-[shadow:var(--shadow-2)] rounded-xl px-6 py-5 text-2xl font-black text-ink placeholder:text-ink/20 outline-none label-sm focus:translate-y-[2px] focus:shadow-[shadow:var(--shadow-1)] transition-all"
                  style={{ textTransform: "label-plain" }}
                />
                {(usernameError || profile.handleError) && (
                  <p className="text-[10px] font-bold text-danger-soft label-plain tracking-wider px-1">{usernameError || profile.handleError}</p>
                )}
              </div>
              <button
                onClick={handleUsernameSubmit}
                disabled={usernameSubmitting || !usernameInput.trim()}
                className="w-full bg-ink text-surface-inverse py-5 rounded-xl font-black label-action-sm text-sm border-1 border-ink shadow-[shadow:var(--shadow-2)] hover:bg-highlight-2 hover:text-ink hover:translate-y-[2px] hover:shadow-[shadow:var(--shadow-1)] transition-all active:translate-y-[4px] active:shadow-none disabled:opacity-40"
              >
                {usernameSubmitting ? t("handle.submitting") : t("handle.submit")}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <KillFeed />
      <WriteFailureToasts />

      {/* GLOBAL HEADER */}
      {headerBand ? (
        /* ── Botanical: a full-width band, then a three-cell stat strip ───── */
        <header
          className="shrink-0 z-20"
          style={{ background: "var(--header-band)", color: "var(--header-ink)" }}
        >
          <div className="max-w-[1600px] mx-auto w-full px-10 pt-10 pb-8">
            <div className="flex justify-between items-start gap-8">
              <div className="min-w-0">
                <h1
                  className="tracking-tight truncate"
                  style={{
                    fontFamily: "var(--font-display)",
                    fontWeight: "var(--weight-display)" as never,
                    fontSize: 46,
                    lineHeight: 1.05,
                  }}
                >
                  {t("header.greeting", { handle: userName, weekday: weekday(), daypart: daypart() })}
                </h1>
                {t("header.sub") && (
                  <p className="mt-2 text-sm font-bold" style={{ color: "var(--header-muted)" }}>
                    {t("header.sub", { weekday: weekday(), daypart: daypart() })}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-8 shrink-0">
                {!reachable && (
                  <span
                    className="flex items-center gap-2 px-3 py-1.5 rounded-full text-[9px] font-bold"
                    style={{ border: "1px solid var(--header-muted)", color: "var(--header-muted)" }}
                    role="status"
                  >
                    {t("offline.pill")}
                  </span>
                )}
                {isActive && (
                  <div className="flex flex-col items-end">
                    <p className="text-[9px] font-bold mb-1" style={{ color: "var(--header-muted)" }}>{t("session.active")}</p>
                    <p className="text-xl font-black tabular-nums leading-none">{formatTime(timeLeft)}</p>
                  </div>
                )}
                <div className="text-right flex flex-col">
                  <p className="text-[9px] font-bold mb-1" style={{ color: "var(--header-muted)" }}>{t("uptime.label")}</p>
                  <p className="text-2xl font-black leading-none">
                    {Math.floor(totalMinutesToday)}<span className="text-xs ml-0.5 opacity-60">{t("uptime.unit")}</span>
                  </p>
                </div>
                <button
                  onClick={logout}
                  className="px-4 py-2 rounded-lg text-[10px] font-bold transition-opacity hover:opacity-80"
                  style={{ border: "1px solid var(--header-muted)", color: "var(--header-ink)" }}
                >
                  {t("signout")}
                </button>
              </div>
            </div>

            {/* Three cells, hairline dividers between them. */}
            <div className="mt-8 flex items-center">
              {[
                t("stats.streak", { streak: String(stats.streak) }),
                t("stats.tasks", { open: String(intentions.filter((i) => !i.completed).length) }),
                t("stats.blocks", { apps: String(stats.apps), sites: String(stats.sites) }),
              ].map((cell, i) => (
                <div
                  key={i}
                  className="flex-1 text-sm font-bold px-6 first:pl-0 last:pr-0"
                  style={i === 0 ? undefined : { borderLeft: "1px solid var(--header-muted)" }}
                >
                  {cell}
                </div>
              ))}
            </div>
          </div>
        </header>
      ) : (
      <header className="shrink-0 px-10 py-8 border-b border-ink/5 bg-surface-inverse/50 backdrop-blur-2xl z-20">
        <div className="flex justify-between items-center max-w-[1600px] mx-auto w-full">
          <div className="flex items-center gap-6">
            <div className="flex flex-col">
              <p className="text-[9px] font-black label-plain tracking-[0.3em] text-ink/30 mb-1">
                {t("header.greeting", { handle: userName, weekday: weekday(), daypart: daypart() })}
              </p>
              <h1 className="text-3xl font-bold tracking-tight text-ink capitalize">
                {currentTab === "home"
                  ? t("dashboard.title")
                  : currentTab === "analytics"
                  ? t("plan.title")
                  : currentTab === "pack"
                  ? t("pack.title")
                  : t("blocks.title")}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-10">
            {!reachable && (
              <span
                className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-surface-alt border-1 border-ink/20 text-[9px] font-black text-ink-muted label-action-sm"
                role="status"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-offline" />
                {t("offline.pill")}
              </span>
            )}
            <button 
              onClick={logout}
              className="px-4 py-2 border-1 border-ink bg-surface text-ink font-black text-[9px] label-action-sm shadow-[shadow:var(--shadow-1)] active:translate-y-[2px] active:shadow-none transition-all"
            >
              {t("signout")}
            </button>

            {/* GLOBAL ACTIVE TIMER */}
            {isActive && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex items-center gap-4 bg-ink text-surface-inverse px-6 py-3 rounded-xl border-1 border-ink shadow-[shadow:var(--shadow-2)]"
              >
                <div className="flex flex-col items-end">
                  <p className="text-[8px] font-black label-sm text-surface-inverse/60 leading-none mb-1">{t("session.active")}</p>
                  <p className="text-xl font-black tabular-nums leading-none tracking-tight">{formatTime(timeLeft)}</p>
                </div>
                <div className="h-6 w-px bg-surface-inverse/20" />
                <p className="text-[10px] font-bold label-plain tracking-tight text-surface-inverse/90 max-w-[100px] truncate leading-tight">
                  {taskLabel || t("session.untitled")}
                </p>
              </motion.div>
            )}

            <div className="text-right flex flex-col">
              <p className="text-[9px] font-black label-sm text-ink/20 mb-1">{t("uptime.label")}</p>
              <p className="text-2xl font-black text-ink leading-none">
                {Math.floor(totalMinutesToday)}<span className="text-xs ml-0.5 opacity-30">{t("uptime.unit")}</span>
              </p>
            </div>
          </div>
        </div>
      </header>
      )}

      <ConnectionGate userId={user.uid} engineOffline={engineOffline} />

      <PendingPermanentBanner userId={user.uid} />

      <UpdateBanner />

      <main className="flex-1 overflow-hidden relative">
        <div className="h-full w-full max-w-[1600px] mx-auto px-10 pt-10 pb-10 overflow-hidden">
          {currentTab === "home" ? (
            <Dashboard 
              userId={user.uid}
              onStartSession={startSession}
              isActive={isActive}
              timeLeft={timeLeft}
              taskLabel={taskLabel}
              onEndSession={() => endSession(false)}
              intentions={intentions}
              setIntentions={setIntentions}
              blocklistHydrated={blocklistHydrated}
              devMode={devMode}
            />
          ) : currentTab === "analytics" ? (
            <Analytics userId={user.uid} />
          ) : currentTab === "pack" ? (
            <ThePack userId={user.uid} />
          ) : (
            <BlockRegistry 
              userId={user.uid}
              userName={userName}
              blockedApps={blockedApps}
              addBlock={handleAddExe}
              removeBlock={handleRemoveExe}
              totalMinutesToday={totalMinutesToday}
              _updateAutostart={updateAutostart}
              isSyncing={isSyncing}
              engineOffline={engineOffline}
            />
          )}
        </div>
      </main>

      {/* NAVIGATION BAR - FIXED ROYAL BLUE V2 */}
      <BottomNav currentTab={currentTab} onChange={setCurrentTab} />
    </div>
  );
}

/**
 * The provider sits outside AppInner so Login and the verification gate — which
 * render before a uid exists — are themed from the localStorage mirror.
 */
export function App() {
  return (
    <ThemeProvider>
      <AppInner />
    </ThemeProvider>
  );
}
