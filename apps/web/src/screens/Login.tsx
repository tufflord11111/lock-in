import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Lock, Shield, Zap, User, Mail, Key, RotateCcw, ArrowLeft, CheckCircle } from "lucide-react";
import { parseAuthError } from "../hooks/useAuth";
import { EnforcerDisarmPanel } from "../components/EnforcerDisarmPanel";

interface LoginProps {
  onLogin: (email: string, pass: string) => Promise<any>;
  onRegister: (email: string, pass: string, username: string) => Promise<any>;
  onForgotPassword: (email: string) => Promise<void>;
}

type AuthView = "login" | "register" | "forgot";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Letters, numbers and underscore only. Registration writes the handle to
// usernames/{NAME}, and a Firebase key may not contain . # $ [ ] or / — a
// dotted handle made that multi-path write fail, leaving the account with no
// profile and no reservation, with nothing surfaced to the user.
const USERNAME_REGEX = /^[A-Za-z0-9_]+$/;
// Mirrors the {1,20} bound in the usernames/$name security rule.
const USERNAME_MAX = 20;

export function Login({ onLogin, onRegister, onForgotPassword }: LoginProps) {
  const [view, setView] = useState<AuthView>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState(false);

  const resetForm = (nextView: AuthView) => {
    setError(null);
    setResetSent(false);
    setPassword("");
    setView(nextView);
  };

  const validateEmail = (val: string) => EMAIL_REGEX.test(val.trim());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // ── Front-end email validation before hitting Firebase ──────────────────
    if (view === "register" && !validateEmail(email)) {
      setError("Please enter a valid email address (e.g. operator@secure.net).");
      return;
    }

    setIsLoading(true);

    try {
      if (view === "register") {
        if (!username.trim()) {
          setError("Operator handle cannot be empty.");
          setIsLoading(false);
          return;
        }
        if (!USERNAME_REGEX.test(username.trim())) {
          setError("Handle can use letters, numbers and underscore only.");
          setIsLoading(false);
          return;
        }
        // Must match the {1,20} bound in the usernames/$name rule. Without
        // this the rule rejects the write and U5 reads that refusal as
        // "handle taken", rolling back a perfectly good registration.
        if (username.trim().length > USERNAME_MAX) {
          setError(`Handle must be ${USERNAME_MAX} characters or fewer.`);
          setIsLoading(false);
          return;
        }
        await onRegister(email.trim(), password, username.trim());
      } else {
        await onLogin(email.trim(), password);
      }
    } catch (err: any) {
      console.error("[Login] Auth error:", err);
      setPassword("");
      setError(parseAuthError(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!validateEmail(email)) {
      setError("Enter a valid email so we can send a reset link.");
      return;
    }

    setIsLoading(true);
    try {
      await onForgotPassword(email.trim());
      setResetSent(true);
    } catch (err: any) {
      setError(parseAuthError(err));
    } finally {
      setIsLoading(false);
    }
  };

  // ── Shared input style ───────────────────────────────────────────────────
  const inputClass =
    "w-full bg-white border-[3px] border-[#002855] p-4 font-bold text-[#002855] shadow-[4px_4px_0px_#002855] outline-none focus:translate-x-[2px] focus:translate-y-[2px] focus:shadow-[2px_2px_0px_#002855] transition-all placeholder:text-[#002855]/20";

  return (
    <div className="min-h-screen bg-[#F9F8F4] flex flex-col items-center justify-center p-8 font-outfit overflow-y-auto">

      {/* HEADER BADGE */}
      <div className="w-full max-w-[400px] bg-white border-[4px] border-[#002855] p-8 shadow-[8px_8px_0px_#002855] mb-8 transform -rotate-1">
        <div className="flex items-center gap-4 mb-4">
          <div className="w-12 h-12 bg-[#002855] flex items-center justify-center">
            <Lock className="text-white" size={24} />
          </div>
          <h1 className="text-4xl font-black text-[#002855] tracking-tighter uppercase italic leading-none">
            Lock-In
          </h1>
        </div>
        <p className="text-[#002855]/60 font-bold leading-tight uppercase text-xs tracking-wider">
          {view === "login" && <>Establish secure link to cockpit.<br />Protocol: STATION_LOGIN</>}
          {view === "register" && <>Establish secure link to cockpit.<br />Protocol: REGISTER_NEW_OPERATOR</>}
          {view === "forgot" && <>Recovery sequence initiated.<br />Protocol: RESET_ACCESS_KEY</>}
        </p>
      </div>

      {/* ── EMERGENCY DISARM ──────────────────────────────────────────────
          A user with a live session and a broken login lands HERE, not on
          the degraded screen, while the enforcer keeps killing. This talks
          only to Rust — no auth, no Firebase — and renders nothing unless
          the enforcer is actually armed, so a normal signed-out user never
          sees it. */}
      <EnforcerDisarmPanel variant="card" className="max-w-[400px] mb-8" />

      {/* ── FORGOT PASSWORD VIEW ─────────────────────────────────────── */}
      <AnimatePresence mode="wait">
        {view === "forgot" && (
          <motion.form
            key="forgot"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            transition={{ duration: 0.2 }}
            onSubmit={handleForgotPassword}
            className="w-full max-w-[400px] flex flex-col gap-5"
          >
            {resetSent ? (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex flex-col items-center gap-4 p-6 bg-green-50 border-[3px] border-green-600 shadow-[4px_4px_0px_#16a34a]"
              >
                <CheckCircle size={32} className="text-green-600" />
                <p className="text-center text-green-700 font-black text-sm uppercase tracking-wider">
                  Reset link dispatched.<br />Check your inbox, Operator.
                </p>
              </motion.div>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 mb-1">
                    <Mail size={14} className="text-[#002855]" />
                    <span className="text-[10px] font-black uppercase text-[#002855]/40 tracking-widest">Comm Link (Email)</span>
                  </div>
                  <input
                    id="forgot-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="operator@secure.net"
                    className={inputClass}
                  />
                </div>

                {error && (
                  <div className="p-3 bg-red-100 border-2 border-red-500 text-red-600 text-[10px] font-black uppercase tracking-wider">
                    ⚠ {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isLoading}
                  className="group relative bg-[#FFD166] border-[4px] border-[#002855] p-5 shadow-[8px_8px_0px_#002855] hover:shadow-[4px_4px_0px_#002855] hover:translate-x-[4px] hover:translate-y-[4px] active:shadow-none active:translate-x-[8px] active:translate-y-[8px] transition-all disabled:opacity-50 mt-2"
                >
                  <div className="flex items-center justify-center gap-3">
                    <RotateCcw className="text-[#002855]" size={18} />
                    <span className="text-lg font-black text-[#002855] uppercase tracking-wider">
                      {isLoading ? "Sending..." : "Send Reset Link"}
                    </span>
                  </div>
                </button>
              </>
            )}

            <button
              type="button"
              onClick={() => resetForm("login")}
              className="flex items-center justify-center gap-2 text-[10px] font-black text-[#002855]/40 uppercase tracking-[0.2em] hover:text-[#002855] transition-colors mt-2"
            >
              <ArrowLeft size={12} />
              Back to Login
            </button>
          </motion.form>
        )}

        {/* ── LOGIN / REGISTER VIEW ────────────────────────────────────── */}
        {(view === "login" || view === "register") && (
          <motion.form
            key={view}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            transition={{ duration: 0.2 }}
            onSubmit={handleSubmit}
            className="w-full max-w-[400px] flex flex-col gap-5"
          >
            {/* Username — register only */}
            <AnimatePresence>
              {view === "register" && (
                <motion.div
                  key="username-field"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden flex flex-col gap-2"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <User size={14} className="text-[#002855]" />
                    <span className="text-[10px] font-black uppercase text-[#002855]/40 tracking-widest">Operator Handle</span>
                  </div>
                  <input
                    id="register-username"
                    type="text"
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="e.g. Ghost_01"
                    className={inputClass}
                  />
                </motion.div>
              )}
            </AnimatePresence>

            {/* Email */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 mb-1">
                <Mail size={14} className="text-[#002855]" />
                <span className="text-[10px] font-black uppercase text-[#002855]/40 tracking-widest">Comm Link (Email)</span>
              </div>
              <input
                id="auth-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="operator@secure.net"
                className={inputClass}
              />
            </div>

            {/* Password */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 mb-1">
                <Key size={14} className="text-[#002855]" />
                <span className="text-[10px] font-black uppercase text-[#002855]/40 tracking-widest">Security Clearance</span>
              </div>
              <input
                id="auth-password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className={inputClass}
              />
            </div>

            {/* Forgot Password link — only on login view */}
            {view === "login" && (
              <button
                type="button"
                onClick={() => resetForm("forgot")}
                className="self-end text-[10px] font-black text-[#002855]/40 uppercase tracking-[0.15em] hover:text-[#002855] transition-colors -mt-2"
              >
                Forgot Access Key?
              </button>
            )}

            {/* Error Banner */}
            {error && (
              <div className="p-3 bg-red-100 border-2 border-red-500 text-red-600 text-[10px] font-black uppercase tracking-wider">
                ⚠ {error}
              </div>
            )}

            {/* Submit */}
            <button
              id="auth-submit"
              type="submit"
              disabled={isLoading}
              className="group relative bg-[#FFD166] border-[4px] border-[#002855] p-5 shadow-[8px_8px_0px_#002855] hover:shadow-[4px_4px_0px_#002855] hover:translate-x-[4px] hover:translate-y-[4px] active:shadow-none active:translate-x-[8px] active:translate-y-[8px] transition-all disabled:opacity-50 mt-4"
            >
              <div className="flex items-center justify-center gap-3">
                <Zap className="text-[#002855] group-hover:animate-pulse" size={20} />
                <span className="text-lg font-black text-[#002855] uppercase tracking-wider">
                  {isLoading ? "Syncing..." : view === "register" ? "Confirm Registration" : "Engage Protocol"}
                </span>
              </div>
            </button>

            {/* Toggle login ↔ register */}
            <button
              type="button"
              onClick={() => resetForm(view === "login" ? "register" : "login")}
              className="text-center text-[10px] font-black text-[#002855]/40 uppercase tracking-[0.2em] hover:text-[#002855] transition-colors mt-2"
            >
              {view === "register" ? "Already documented? Login here" : "First time arriving? Create Account"}
            </button>

            {/* Footer badges */}
            <div className="flex items-center justify-center gap-6 mt-4">
              <div className="flex items-center gap-2 text-[#002855]/40 font-black text-[10px] uppercase tracking-widest">
                <Shield size={12} />
                <span>Encrypted Layer</span>
              </div>
              <div className="w-px h-4 bg-[#002855]/10" />
              <div className="text-[#002855]/40 font-black text-[10px] uppercase tracking-widest">
                v0.1.5 Alpha
              </div>
            </div>
          </motion.form>
        )}
      </AnimatePresence>

      {/* DECORATIVE BACKGROUND TEXT */}
      <div className="fixed bottom-12 left-12 opacity-5 transform -rotate-12 pointer-events-none select-none">
        <h2 className="text-8xl font-black text-[#002855] leading-none uppercase">FOCUS</h2>
      </div>
      <div className="fixed top-12 right-12 opacity-5 transform rotate-12 pointer-events-none select-none">
        <h2 className="text-8xl font-black text-[#002855] leading-none uppercase">GRIND</h2>
      </div>
    </div>
  );
}
