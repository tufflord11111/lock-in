import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion, AnimatePresence } from "framer-motion";
import { db } from "@lock-in/firebase";
import { ref, set, onValue, update, get } from "firebase/database";
import { BottomNav, type AppTab } from "./components/BottomNav";
import { X } from "lucide-react";
import { useFocusSession } from "./hooks/useFocusSession";
import { useOmniSync } from "./hooks/useOmniSync";
import { usePresence } from "./hooks/usePresence";
import { emptyTasksByDay, type TasksByDay } from "./plannedTasks";
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
        className="w-full h-12 bg-[#F5C842] text-[#1B2A4A] flex items-center justify-between px-6 z-30 shrink-0 font-mono text-xs font-bold shadow-[0_4px_0px_rgba(27,42,74,0.1)]"
        style={{ fontFamily: "'Space Mono', monospace" }}
      >
        <span className="flex-1 text-center truncate pr-4">{message}</span>
        <button
          onClick={() => setDismissed(true)}
          className="hover:bg-[#1B2A4A]/10 p-1 rounded transition-colors"
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
    <div className="w-screen h-screen bg-[#F9F8F4] flex items-center justify-center">
      <div className="flex flex-col items-center gap-6 px-8 text-center">
        <div className="w-12 h-12 border-4 border-[#002855]/20 border-t-[#002855] rounded-full animate-spin" />
        <div className="flex flex-col gap-2">
          <span className="text-[11px] font-black uppercase tracking-widest text-[#002855]">
            Network Initializing...
          </span>
          <span className="text-[10px] font-bold text-[#002855]/40 uppercase tracking-wide">
            Waiting for connection. The app will load automatically.
          </span>
        </div>

        <div className="flex flex-col gap-3 w-full max-w-xs">
          <button
            onClick={() => window.location.reload()}
            className="px-6 py-3 bg-[#002855] text-white font-black text-[10px] uppercase tracking-widest rounded-xl border-2 border-[#002855] shadow-[2px_2px_0px_#002855] hover:-translate-y-0.5 hover:shadow-[4px_4px_0px_#002855] active:translate-y-0 active:shadow-none transition-all"
          >
            Retry Connection
          </button>

          {authDegraded && (
            <button
              onClick={onForceOffline}
              className="px-6 py-3 bg-transparent text-[#002855]/50 font-black text-[10px] uppercase tracking-widest rounded-xl border-2 border-[#002855]/20 hover:border-[#002855]/50 hover:text-[#002855] transition-all"
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

export function App() {
  const {
    user,
    loading,
    emailVerified,
    isNewUser,
    authDegraded,
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
  const [tasks, setTasks] = useState<TasksByDay>(emptyTasksByDay);
  const [totalMinutesFocused, setTotalMinutesFocused] = useState(0);
  const [usernameInput, setUsernameInput] = useState("");
  const [usernameError, setUsernameError] = useState("");
  const [usernameSubmitting, setUsernameSubmitting] = useState(false);
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
  const [blockedApps, setBlockedApps] = useState<string[]>([]);
  // Raw {key: exe} and the parallel {key: originDeviceId} map, needed to tell
  // Rust which entries this device vouches for.
  const [blockedAppsRaw, setBlockedAppsRaw] = useState<Record<string, string>>({});
  const [blockedAppsMeta, setBlockedAppsMeta] = useState<Record<string, string>>({});
  // False until the blockedApps listener has fired at least once. An empty
  // blockedApps array is ambiguous — "no blocks configured" or "Firebase hasn't
  // answered yet" — so this distinguishes them for the start-button advisory.
  const [blocklistHydrated, setBlocklistHydrated] = useState(false);
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
    deviceBreakdown, 
    lockMode,
    updateLockMode,
    totalMinutesToday,
    autostartEnabled,
    updateAutostart,
    customBlocks,
    addBlock,
    removeBlock,
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
      <div className="w-screen h-screen bg-[#F9F8F4] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-4 border-[#002855] border-t-transparent rounded-full animate-spin" />
          <span className="text-[10px] font-black uppercase tracking-widest text-[#002855]/40 italic">
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
      />
    );
  }

  return (
    <div className="relative w-screen h-screen m-0 p-0 box-border bg-[#F9F8F4] text-[#002855] overflow-hidden flex flex-col font-sans">
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
        {onboardingComplete === true && profile.status === "ready" && profile.usernameSet === false && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[200] bg-[#F9F8F4] flex items-center justify-center"
          >
            <div className="w-full max-w-md flex flex-col items-center gap-8 px-8">
              <p className="text-[10px] font-black uppercase tracking-[0.4em] text-[#002855]/30">// Operator Registration</p>
              <div className="text-center">
                <h1 className="text-5xl font-black text-[#002855] uppercase tracking-tight mb-3">Choose Your Handle</h1>
                <p className="text-xs font-bold text-[#002855]/40 uppercase tracking-wider">This cannot be changed after confirmation.</p>
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
                  className="w-full bg-white border-2 border-[#002855] shadow-[4px_4px_0px_#002855] rounded-2xl px-6 py-5 text-2xl font-black text-[#002855] placeholder:text-[#002855]/20 outline-none uppercase tracking-widest focus:translate-y-[2px] focus:shadow-[2px_2px_0px_#002855] transition-all"
                  style={{ textTransform: "uppercase" }}
                />
                {(usernameError || profile.handleError) && (
                  <p className="text-[10px] font-bold text-red-500 uppercase tracking-wider px-1">{usernameError || profile.handleError}</p>
                )}
              </div>
              <button
                onClick={handleUsernameSubmit}
                disabled={usernameSubmitting || !usernameInput.trim()}
                className="w-full bg-[#002855] text-white py-5 rounded-2xl font-black uppercase tracking-widest text-sm border-2 border-[#002855] shadow-[4px_4px_0px_#002855] hover:bg-[#F5C842] hover:text-[#002855] hover:translate-y-[2px] hover:shadow-[2px_2px_0px_#002855] transition-all active:translate-y-[4px] active:shadow-none disabled:opacity-40"
              >
                {usernameSubmitting ? "Locking In..." : "Lock In Handle"}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <KillFeed />
      <WriteFailureToasts />

      {/* GLOBAL HEADER */}
      <header className="shrink-0 px-10 py-8 border-b border-royal-blue/5 bg-white/50 backdrop-blur-2xl z-20">
        <div className="flex justify-between items-center max-w-[1600px] mx-auto w-full">
          <div className="flex items-center gap-6">
            <div className="flex flex-col">
              <p className="text-[9px] font-black uppercase tracking-[0.3em] text-royal-blue/30 mb-1">
                Operator // {userName}
              </p>
              <h1 className="text-3xl font-bold tracking-tight text-royal-blue capitalize">
                {currentTab === "home" ? "Cockpit Dashboard" : currentTab === "analytics" ? "Strategic Planner" : currentTab === "pack" ? "The Pack" : "System Protocols"}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-10">
            <button 
              onClick={logout}
              className="px-4 py-2 border-2 border-[#002855] bg-white text-[#002855] font-black text-[9px] uppercase tracking-widest shadow-[2px_2px_0px_#002855] active:translate-y-[2px] active:shadow-none transition-all"
            >
              Sign Out
            </button>

            {/* GLOBAL ACTIVE TIMER */}
            {isActive && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex items-center gap-4 bg-royal-blue text-white px-6 py-3 rounded-2xl border-2 border-[#002855] shadow-[4px_4px_0px_#002855]"
              >
                <div className="flex flex-col items-end">
                  <p className="text-[8px] font-black uppercase tracking-widest text-white/60 leading-none mb-1">Active Session</p>
                  <p className="text-xl font-black tabular-nums leading-none tracking-tight">{formatTime(timeLeft)}</p>
                </div>
                <div className="h-6 w-px bg-white/20" />
                <p className="text-[10px] font-bold uppercase tracking-tight text-white/90 max-w-[100px] truncate leading-tight">
                  {taskLabel || "Untethered"}
                </p>
              </motion.div>
            )}

            <div className="text-right flex flex-col">
              <p className="text-[9px] font-black uppercase tracking-widest text-royal-blue/20 mb-1">Uptime today</p>
              <p className="text-2xl font-black text-royal-blue leading-none">
                {Math.floor(totalMinutesToday)}<span className="text-xs ml-0.5 opacity-30">MIN</span>
              </p>
            </div>
          </div>
        </div>
      </header>

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
              customBlocks={customBlocks}
              addBlock={handleAddExe}
              removeBlock={handleRemoveExe}
              totalMinutesToday={totalMinutesToday}
              _autostartEnabled={autostartEnabled}
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


