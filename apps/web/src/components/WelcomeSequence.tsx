import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Target, Lock, Zap, Cpu, CheckCircle, XCircle,
  Puzzle, Link2, Copy, ChevronRight, Download, AlertTriangle,
} from "lucide-react";
import { getDatabase, ref as dbRef, onValue, update } from "firebase/database";
import { db } from "@lock-in/firebase";
import { awaitWriteOrQueue } from "../offlineWrite";
import { reportWriteFailure } from "../writeFailures";

// Tauri detect
const isTauri = typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;
const LS_KEY = "lockin_extension_id";
const DEFAULT_EXT_ID = "phmiffemaackgcngikgmmjjgbpkmjoao";

// (pingExtension retired in favor of Cloud Heartbeat)

// ─── Types ─────────────────────────────────────────────────────────────────────
type SniperState = "idle" | "checking" | "online" | "degraded";

interface WelcomeSequenceProps {
  userName: string;
  userId: string;
  onComplete: () => void;
}

// ─── Philosophy steps ──────────────────────────────────────────────────────────
const STEPS = [
  { icon: Target, number: "01", title: "Pick Your Targets",  body: "Define the handful of missions that actually matter. No noise — pure signal." },
  { icon: Lock,   number: "02", title: "Lock The Gates",     body: "The engine terminates every distraction. Social feeds, games, idle tabs — gone." },
  { icon: Zap,    number: "03", title: "No Distractions",    body: "You operate in a sealed chamber of focus. The work is all that exists." },
];

// ─── Linking Protocol overlay ──────────────────────────────────────────────────
const PROTOCOL_STEPS = [
  { n: "01", text: "Open the Chrome Web Store and search for", code: "Lock-In" },
  { n: "02", text: "Click \"Add to Chrome\" and confirm the installation prompt", code: null },
  { n: "03", text: "Click the Lock-In icon in your Chrome toolbar", code: "Extensions Menu" },
  { n: "04", text: "Log in with the same Lock-In account you used on this desktop app", code: null },
];

const STORE_URL = "https://chrome.google.com/webstore/search/Lock-In";

function LinkingProtocol({
  onClose,
  onLinked,
  userId,
  extDetected,
}: {
  onClose: () => void;
  onLinked: (id: string) => void;
  userId: string;
  extDetected: boolean | null;
}) {
  const [copied, setCopied]           = useState(false);
  const [showLinked, setShowLinked]   = useState(false);

  // The desktop build has no way to open a browser: the button used
  // @tauri-apps/plugin-shell, but the Rust side never had tauri-plugin-shell,
  // so open() threw and the button did nothing. Rather than add a plugin (and
  // an open-URL capability) for one link, the desktop shows the link and
  // copies it; a plain browser can still open it directly.
  const handleStore = () => {
    if (!isTauri) {
      window.open(STORE_URL, "_blank");
      return;
    }
    handleCopy(STORE_URL);
  };

  useEffect(() => {
    if (extDetected) {
      setShowLinked(true);
      setTimeout(() => onLinked("firebase_heartbeat"), 1800);
    }
  }, [extDetected, onLinked]);

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <motion.div
      className="fixed inset-0 z-[60] flex items-center justify-center p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={!showLinked ? onClose : undefined} />

      {/* ── SYSTEM LINKED splash ──────────────────────────────────────────────── */}
      <AnimatePresence>
        {showLinked && (
          <motion.div
            key="linked-splash"
            className="relative z-10 flex flex-col items-center gap-6 text-center"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.1 }}
            transition={{ duration: 0.45, ease: "easeOut" }}
          >
            {/* Ring pulse */}
            <motion.div
              className="relative flex items-center justify-center"
              animate={{ scale: [1, 1.12, 1] }}
              transition={{ repeat: 2, duration: 0.55 }}
            >
              <div className="absolute w-32 h-32 rounded-full bg-green-400/10 animate-ping" />
              <div className="w-24 h-24 bg-green-400 flex items-center justify-center shadow-[0_0_60px_rgba(74,222,128,0.6)]">
                <CheckCircle size={44} className="text-[#002855]" />
              </div>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.25 }}
            >
              <p className="text-[10px] font-black uppercase tracking-[0.4em] text-green-400/70 mb-2">Handshake Confirmed</p>
              <h2 className="text-4xl font-black text-white uppercase tracking-tight">System<br /><span className="text-green-400">Linked</span></h2>
            </motion.div>
            <motion.div
              initial={{ scaleX: 0 }} animate={{ scaleX: 1 }}
              transition={{ delay: 0.5, duration: 0.5 }}
              className="h-[3px] w-20 bg-green-400 origin-center"
            />
            <p className="text-[10px] font-black uppercase tracking-widest text-white/30">Advancing to cockpit...</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Main modal ───────────────────────────────────────────────────────── */}
      {!showLinked && (
        <motion.div
          className="relative w-full max-w-[440px] bg-[#001a3a] border-[3px] border-[#FFD166] shadow-[8px_8px_0px_#FFD166] overflow-y-auto max-h-[90vh]"
          initial={{ scale: 0.92, y: 20 }}
          animate={{ scale: 1, y: 0 }}
          exit={{ scale: 0.92, y: 20 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
        >
          {/* Header */}
          <div className="flex items-center gap-3 px-6 pt-6 pb-4 border-b-[2px] border-white/10">
            <div className="w-10 h-10 bg-[#FFD166] flex items-center justify-center shrink-0">
              <Link2 size={18} className="text-[#002855]" />
            </div>
            <div>
              <p className="text-[9px] font-black uppercase tracking-[0.35em] text-[#FFD166]">Linking Protocol</p>
              <h3 className="text-lg font-black text-white uppercase tracking-tight leading-tight">Manual Extension Sync</h3>
            </div>
            <button onClick={onClose} className="ml-auto text-white/30 hover:text-white transition-colors text-lg font-black">✕</button>
          </div>

          {/* ── Step 0: Export button ─────────────────────────────────────── */}
          <div className="px-6 pt-5 pb-0">
            <p className="text-[9px] font-black uppercase tracking-[0.3em] text-[#FFD166] mb-2">Step 0 — INSTALL WEB GUARD</p>
            <button
              id="export-extension-btn"
              onClick={handleStore}
              className="w-full flex items-center justify-center gap-2 bg-white/5 border-[2px] border-[#FFD166]/30 hover:border-[#FFD166] text-[#FFD166] font-black text-[10px] uppercase tracking-widest py-3 px-4 transition-all disabled:opacity-50"
            >
              <Download size={13} />
              {isTauri ? "COPY CHROME WEB STORE LINK" : "OPEN CHROME WEB STORE"}
            </button>
            {isTauri && (
              <p className="mt-2 text-[9px] font-mono text-[#FFD166]/70 break-all select-all">
                {STORE_URL}
              </p>
            )}
          </div>

          {/* ── Protocol steps ───────────────────────────────────────────── */}
          <div className="px-6 py-4 flex flex-col gap-3 border-t border-white/5 mt-4">
            {PROTOCOL_STEPS.map((s) => (
              <div key={s.n} className="flex gap-3 items-start">
                <span className="text-[9px] font-black text-[#FFD166] tracking-[0.2em] mt-0.5 shrink-0">{s.n}</span>
                <div className="flex flex-col gap-1">
                  <p className="text-white/60 font-bold text-[11px] leading-snug">{s.text}</p>
                  {s.code && (
                    <button
                      onClick={() => handleCopy(s.code!)}
                      className="flex items-center gap-1.5 self-start px-2 py-1 bg-white/5 border border-white/10 hover:border-[#FFD166]/40 transition-colors group"
                    >
                      <code className="text-[#FFD166] font-mono text-[10px]">{s.code}</code>
                      <Copy size={9} className="text-white/20 group-hover:text-[#FFD166] transition-colors" />
                    </button>
                  )}
                </div>
              </div>
            ))}
            {copied && <p className="text-[9px] font-black text-green-400 uppercase tracking-wider">Copied!</p>}
          </div>

          {/* ── Auto-Verification Indicator ─────────────────────────────────── */}
          <div className="px-6 pb-8 flex flex-col gap-4">
            <div className="relative group">
              <div className="absolute -inset-[1px] bg-gradient-to-r from-[#FFD166]/20 via-[#FFD166]/40 to-[#FFD166]/20 blur opacity-30 group-hover:opacity-100 transition duration-1000" />
              <button
                disabled={true}
                className="relative w-full h-14 bg-[#0a0f1d] border border-white/10 rounded-xl flex items-center justify-center gap-3 text-white/50 font-black cursor-not-allowed uppercase tracking-[0.2em] text-[10px]"
              >
                <Cpu className="w-5 h-5 text-[#FFD166] animate-pulse" />
                Checking for Web Guard...
              </button>
            </div>



            <p className="text-[10px] text-white/30 font-bold uppercase tracking-[0.1em] text-center italic">
              LINKING WILL HAPPEN AUTOMATICALLY ONCE YOU LOG IN TO THE EXTENSION.
            </p>
          </div>
        </motion.div>
      )}
    </motion.div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────────
function WelcomeSequence({ userName, userId, onComplete }: WelcomeSequenceProps) {
  const [step, setStep]               = useState(-1);
  const [sniperState, setSniperState] = useState<SniperState>("idle");
  const [sniperMsg, setSniperMsg]     = useState("");
  const [extDetected, setExtDetected] = useState<boolean | null>(null);
  const [showProtocol, setShowProtocol] = useState(false);
  const [linkedId, setLinkedId]       = useState<string | null>(null);

  // Auto-advance greeting
  useEffect(() => {
    if (step === -1) {
      const t = setTimeout(() => setStep(0), 2200);
      return () => clearTimeout(t);
    }
  }, [step]);

  // Extension heartbeat check (Cloud Handshake)
  useEffect(() => {
    if (!userId) return;
    const heartbeatRef = dbRef(
      db, 
      `users/${userId}/extension_state/last_seen`
    );
    const unsubscribe = onValue(
      heartbeatRef,
      (snapshot) => {
        const lastSeen = snapshot.val();
        if (lastSeen) {
          const diff = Date.now() - lastSeen;
          if (diff < 300000) {
            setExtDetected(true);
          }
        }
      },
      (error: any) => {
        console.error('[HB] error:', error.code || error.message);
      }
    );
    return () => unsubscribe();
  }, [userId]);

  // ── Sniper ──────────────────────────────────────────────────────────────────
  const handleActivateSniper = async () => {
    setSniperState("checking");
    setSniperMsg("");
    try {
      if (isTauri) {
        const { invoke } = await import("@tauri-apps/api/core");
        const status = await invoke<{ ready: boolean; message: string }>("check_sniper");
        if (status?.ready) {
          setSniperState("online");
          setSniperMsg(status.message ?? "Sniper subsystem online.");
        } else {
          setSniperState("degraded");
          setSniperMsg(status?.message ?? "Sniper subsystem degraded.");
        }
      } else {
        await new Promise((r) => setTimeout(r, 900));
        setSniperState("online");
        setSniperMsg("Desktop engine not detected — running in browser mode.");
      }
    } catch (err: any) {
      setSniperState("degraded");
      setSniperMsg(err?.message ?? "Calibration command failed.");
    }
  };

  // ── Complete ─────────────────────────────────────────────────────────────────
  const handleComplete = async () => {
    // Raced: offline, this await never returned and onComplete never ran, so
    // the operator was stuck on the last onboarding step with no message.
    // Still non-fatal either way — setup finishes on this device regardless.
    const lateErrorMessage =
      "Couldn't save that you finished setup, so you may see it again next launch.";
    try {
      await awaitWriteOrQueue(
        update(dbRef(db, `users/${userId}/config`), { onboardingComplete: true }),
        { lateErrorMessage }
      );
    } catch (err) {
      reportWriteFailure(lateErrorMessage, err);
    }
    onComplete();
  };

  // ── Linking Protocol callback ─────────────────────────────────────────────
  const handleLinked = (id: string) => {
    setLinkedId(id);
    setExtDetected(true);
    setShowProtocol(false);
  };

  const TOTAL_STEPS = STEPS.length + 1;
  const showDots    = step >= 0;

  return (
    <>
      <motion.div
        className="fixed inset-0 z-50 bg-[#002855] flex flex-col items-center justify-center p-8 overflow-hidden"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.4 }}
      >
        {/* Grain */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.04]"
          style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")" }}
        />

        <AnimatePresence mode="wait">
          {/* ── GREETING ──────────────────────────────────────────────────── */}
          {step === -1 && (
            <motion.div key="greeting"
              initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.05 }} transition={{ duration: 0.5 }}
              className="text-center flex flex-col items-center gap-6"
            >
              <motion.div
                animate={{ rotate: [0, -3, 3, -2, 2, 0] }}
                transition={{ delay: 0.6, duration: 0.8 }}
                className="w-20 h-20 bg-[#FFD166] border-[4px] border-white flex items-center justify-center shadow-[6px_6px_0px_rgba(255,255,255,0.2)]"
              >
                <Lock size={36} className="text-[#002855]" />
              </motion.div>
              <div>
                <motion.p initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}
                  className="text-[11px] font-black uppercase tracking-[0.4em] text-white/40 mb-3">
                  Identity Verified
                </motion.p>
                <motion.h1 initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }}
                  className="text-5xl font-black text-white uppercase tracking-tight leading-none">
                  Welcome,<br />
                  <span className="text-[#FFD166]">{userName || "Operator"}</span>
                </motion.h1>
              </div>
              <motion.div
                initial={{ scaleX: 0 }} animate={{ scaleX: 1 }}
                transition={{ delay: 1.0, duration: 0.6 }}
                className="h-[3px] w-32 bg-[#FFD166] origin-left"
              />
            </motion.div>
          )}

          {/* ── PHILOSOPHY STEPS ────────────────────────────────────────────── */}
          {step >= 0 && step < STEPS.length && (
            <motion.div key={`step-${step}`}
              initial={{ opacity: 0, x: 60 }} animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -60 }} transition={{ duration: 0.35, ease: "easeOut" }}
              className="w-full max-w-[440px] flex flex-col gap-8"
            >
              {showDots && (
                <div className="flex gap-2 justify-center">
                  {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
                    <div key={i} className={`h-1.5 rounded-full transition-all duration-300 ${
                      i === step ? "w-8 bg-[#FFD166]" : i < step ? "w-4 bg-white/40" : "w-4 bg-white/15"
                    }`} />
                  ))}
                </div>
              )}
              <div className="bg-white/5 border-[3px] border-white/20 p-8 shadow-[8px_8px_0px_rgba(255,255,255,0.08)]">
                <div className="flex items-start gap-6">
                  <div className="shrink-0 flex flex-col items-center gap-3">
                    <span className="text-[10px] font-black text-[#FFD166] tracking-[0.3em]">STEP {STEPS[step].number}</span>
                    <div className="w-14 h-14 bg-[#FFD166] flex items-center justify-center border-[3px] border-white/20 shadow-[4px_4px_0px_rgba(255,255,255,0.1)]">
                      {(() => { const Icon = STEPS[step].icon; return <Icon size={24} className="text-[#002855]" />; })()}
                    </div>
                  </div>
                  <div className="flex flex-col gap-3 pt-7">
                    <h2 className="text-2xl font-black text-white uppercase tracking-tight leading-tight">{STEPS[step].title}</h2>
                    <p className="text-white/60 font-bold text-sm leading-relaxed">{STEPS[step].body}</p>
                  </div>
                </div>
              </div>
              <div className="flex gap-4">
                {step > 0 && (
                  <button onClick={() => setStep((s) => s - 1)}
                    className="flex-1 border-[3px] border-white/20 text-white/50 font-black text-[10px] uppercase tracking-widest py-4 hover:text-white hover:border-white/40 transition-colors">
                    Back
                  </button>
                )}
                <button onClick={() => setStep((s) => s + 1)}
                  className="flex-1 bg-[#FFD166] border-[3px] border-white/20 text-[#002855] font-black text-[10px] uppercase tracking-widest py-4 shadow-[4px_4px_0px_rgba(255,255,255,0.1)] hover:shadow-none hover:translate-x-[4px] hover:translate-y-[4px] transition-all">
                  {step === STEPS.length - 1 ? "Calibrate System →" : "Next →"}
                </button>
              </div>
              <button onClick={handleComplete}
                className="self-center text-[9px] font-black uppercase tracking-[0.3em] text-white/20 hover:text-white/50 transition-colors">
                Skip Briefing
              </button>
            </motion.div>
          )}

          {/* ── CALIBRATION STEP ────────────────────────────────────────────── */}
          {step === STEPS.length && (
            <motion.div key="calibration"
              initial={{ opacity: 0, x: 60 }} animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -60 }} transition={{ duration: 0.35, ease: "easeOut" }}
              className="w-full max-w-[440px] flex flex-col gap-6"
            >
              {/* Progress dots */}
              <div className="flex gap-2 justify-center">
                {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
                  <div key={i} className={`h-1.5 rounded-full transition-all duration-300 ${
                    i === step ? "w-8 bg-[#FFD166]" : i < step ? "w-4 bg-white/40" : "w-4 bg-white/15"
                  }`} />
                ))}
              </div>

              {/* Header */}
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 bg-[#FFD166] flex items-center justify-center border-[3px] border-white/20 shrink-0">
                  <Cpu size={24} className="text-[#002855]" />
                </div>
                <div>
                  <p className="text-[10px] font-black text-[#FFD166] tracking-[0.3em] mb-1">STEP 04</p>
                  <h2 className="text-2xl font-black text-white uppercase tracking-tight leading-tight">System Calibration</h2>
                </div>
              </div>

              {/* Sniper card */}
              <div className="bg-white/5 border-[3px] border-white/20 p-6 shadow-[8px_8px_0px_rgba(255,255,255,0.08)] flex flex-col gap-4">
                <p className="text-white/60 font-bold text-sm leading-relaxed">
                  Verify the Rust process-sniper is armed and ready to terminate
                  distracting applications the moment a lock session begins.
                </p>
                <AnimatePresence mode="wait">
                  {sniperState === "idle" && (
                    <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                      className="flex items-center gap-3 text-white/30 font-black text-[10px] uppercase tracking-wider">
                      <div className="w-2 h-2 rounded-full bg-white/20" /> Awaiting activation
                    </motion.div>
                  )}
                  {sniperState === "checking" && (
                    <motion.div key="checking" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                      className="flex items-center gap-3 text-[#FFD166] font-black text-[10px] uppercase tracking-wider">
                      <div className="w-2 h-2 rounded-full bg-[#FFD166] animate-pulse" /> Calibrating sniper subsystem...
                    </motion.div>
                  )}
                  {sniperState === "online" && (
                    <motion.div key="online" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
                      <div className="flex items-center gap-3 px-4 py-3 border-[2px] border-green-400/40 w-full"
                        style={{ boxShadow: "0 0 16px rgba(74,222,128,0.25)" }}>
                        <CheckCircle size={18} className="text-green-400 shrink-0" />
                        <div>
                          <p className="text-green-400 font-black text-[10px] uppercase tracking-wider">System Verified</p>
                          <p className="text-green-400/70 font-bold text-[10px] mt-0.5">{sniperMsg}</p>
                        </div>
                      </div>
                    </motion.div>
                  )}
                  {sniperState === "degraded" && (
                    <motion.div key="degraded" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                      className="flex items-start gap-3 px-4 py-3 border-[2px] border-red-500/40"
                      style={{ boxShadow: "0 0 12px rgba(239,68,68,0.2)" }}>
                      <XCircle size={18} className="text-red-400 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-red-400 font-black text-[10px] uppercase tracking-wider">Sniper Degraded</p>
                        <p className="text-red-400/70 font-bold text-[10px] mt-0.5">{sniperMsg}</p>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
                {sniperState !== "online" && (
                  <button id="calibrate-sniper" onClick={handleActivateSniper}
                    disabled={sniperState === "checking"}
                    className="group bg-[#FFD166] border-[3px] border-white/20 text-[#002855] font-black text-[11px] uppercase tracking-widest py-4 shadow-[4px_4px_0px_rgba(255,255,255,0.1)] hover:shadow-none hover:translate-x-[2px] hover:translate-y-[2px] transition-all disabled:opacity-50 flex items-center justify-center gap-3">
                    <Cpu size={16} className={sniperState === "checking" ? "animate-spin" : ""} />
                    {sniperState === "checking" ? "Calibrating..." : "Activate Sniper"}
                  </button>
                )}
              </div>

              {/* ── Extension Status card ──────────────────────────────────── */}
              <motion.div
                animate={extDetected === true ? { scale: [1, 1.02, 1] } : {}}
                transition={{ duration: 0.4 }}
                className={`border-[3px] p-5 flex items-center justify-between gap-4 transition-colors duration-500 ${
                  extDetected === true
                    ? "bg-green-400/5 border-green-400/40"
                    : "bg-white/5 border-white/10"
                }`}
                style={extDetected === true ? { boxShadow: "0 0 20px rgba(74,222,128,0.15)" } : {}}
              >
                <div className="flex items-center gap-3">
                  <motion.div
                    animate={extDetected === true ? { scale: [1, 1.3, 1] } : {}}
                    transition={{ duration: 0.45 }}
                  >
                    <Puzzle size={18} className={extDetected === true ? "text-green-400" : "text-white/30"} />
                  </motion.div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-wider text-white/50">Chrome Extension</p>
                    <AnimatePresence mode="wait">
                      {extDetected === null && (
                        <motion.p key="detecting" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                          className="text-[11px] font-black uppercase tracking-wide mt-0.5 text-white/30">
                          Detecting...
                        </motion.p>
                      )}
                      {extDetected === true && (
                        <motion.p key="linked"
                          initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                          className="text-[11px] font-black uppercase tracking-wide mt-0.5 text-green-400">
                          System Linked ✓{linkedId ? " — ID Saved" : ""}
                        </motion.p>
                      )}
                      {extDetected === false && (
                        <motion.p key="notfound" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                          className="text-[11px] font-black uppercase tracking-wide mt-0.5 text-yellow-400">
                          Not Detected
                        </motion.p>
                      )}
                    </AnimatePresence>
                  </div>
                </div>

                {/* Action button — changes based on state */}
                {extDetected !== true && (
                  <button
                    id="view-linking-protocol"
                    onClick={() => setShowProtocol(true)}
                    className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest text-[#FFD166] hover:text-white transition-colors border-b border-[#FFD166]/40 hover:border-white/40 pb-0.5 whitespace-nowrap"
                  >
                    {extDetected === null ? "Detect..." : "View Linking Protocol"}
                    <ChevronRight size={10} />
                  </button>
                )}
                {extDetected === true && (
                  <button
                    onClick={() => { setExtDetected(false); }}
                    className="text-[9px] font-black uppercase tracking-widest text-green-400/50 hover:text-green-400 transition-colors pb-0.5 border-b border-green-400/20 hover:border-green-400/40 whitespace-nowrap"
                  >
                    Re-scan
                  </button>
                )}
              </motion.div>

              {/* Navigation */}
              <div className="flex gap-4">
                <button onClick={() => setStep(STEPS.length - 1)}
                  className="flex-1 border-[3px] border-white/20 text-white/50 font-black text-[10px] uppercase tracking-widest py-4 hover:text-white hover:border-white/40 transition-colors">
                  Back
                </button>
                <button id="enter-cockpit" 
                  onClick={handleComplete}
                  disabled={!extDetected}
                  className="flex-1 bg-[#FFD166] border-[3px] border-white/20 text-[#002855] font-black text-[10px] uppercase tracking-widest py-4 shadow-[4px_4px_0px_rgba(255,255,255,0.1)] hover:shadow-none hover:translate-x-[4px] hover:translate-y-[4px] transition-all disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed">
                  Enter Cockpit →
                </button>
              </div>

              <button onClick={handleComplete}
                className="self-center text-[9px] font-black uppercase tracking-[0.3em] text-white/20 hover:text-white/50 transition-colors">
                Skip Calibration
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* ── Linking Protocol overlay (portalled above main) ─────────────────── */}
      <AnimatePresence>
        {showProtocol && (
          <LinkingProtocol
            onClose={() => setShowProtocol(false)}
            onLinked={handleLinked}
            userId={userId}
            extDetected={extDetected}
          />
        )}
      </AnimatePresence>
    </>
  );
}

export default WelcomeSequence;
