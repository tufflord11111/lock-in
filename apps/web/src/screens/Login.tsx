import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Lock, Shield, Zap, User, Mail, Key, RotateCcw, ArrowLeft, CheckCircle } from "lucide-react";
import { parseAuthError } from "../hooks/useAuth";
import { EnforcerDisarmPanel } from "../components/EnforcerDisarmPanel";
import { useCopy } from "../theme/copy";

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

// The footer build stamp. Under Tauri this is the real bundle version from
// tauri.conf.json, so a shipped build can never disagree with the release it
// came from — the previous hardcoded "v0.1.5 Alpha" survived six releases.
// The browser build has no bundle version of its own, hence "web".
const isTauri =
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

function useAppVersion(): string {
  const [version, setVersion] = useState("web");
  useEffect(() => {
    if (!isTauri) return;
    let alive = true;
    import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then((v) => {
        if (alive) setVersion("v" + v);
      })
      .catch(() => {
        /* keep "web" rather than showing a version we could not confirm */
      });
    return () => {
      alive = false;
    };
  }, []);
  return version;
}

/** Raised when sign-in has not come back inside SIGN_IN_DEADLINE_MS. */
class SignInUnreachableError extends Error {
  code = "sign-in-unreachable" as const;
}

/**
 * Firebase's own timeout is 30 s, and a blocked network takes ~21 s to fail at
 * the TCP layer. Neither is a wait anyone will sit through, so we stop first
 * and say something the operator can act on.
 */
const SIGN_IN_DEADLINE_MS = 8000;

function withSignInDeadline<T>(work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new SignInUnreachableError()), SIGN_IN_DEADLINE_MS)
    ),
  ]);
}

export function Login({ onLogin, onRegister, onForgotPassword }: LoginProps) {
  const [view, setView] = useState<AuthView>("login");
  const appVersion = useAppVersion();
  const t = useCopy();
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

    // An empty form used to go to the server anyway: Firebase does not reject
    // it locally, so with Google unreachable the button sat dead for 21 s and
    // then showed a network error. Say the obvious thing instantly instead.
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
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
        await withSignInDeadline(onRegister(email.trim(), password, username.trim()));
      } else {
        await withSignInDeadline(onLogin(email.trim(), password));
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
    "w-full bg-surface border-auth border-ink rounded-auth-field p-4 font-bold text-ink shadow-[shadow:var(--shadow-2)] outline-none focus:translate-x-[2px] focus:translate-y-[2px] focus:shadow-[shadow:var(--shadow-1)] transition-all placeholder:text-ink/20";

  return (
    <div className="h-screen bg-ground flex flex-col items-center [justify-content:safe_center] p-8 font-outfit overflow-y-auto">

      {/* HEADER BADGE */}
      <div
        className="w-full max-w-[400px] bg-surface border-2 border-ink rounded-auth-card p-8 shadow-[shadow:var(--shadow-4)] mb-8"
        style={{ transform: "rotate(var(--rotate-logo))" }}
      >
        <div className="flex items-center gap-4 mb-4">
          <div className="w-12 h-12 bg-ink rounded-auth-field flex items-center justify-center">
            <Lock className="text-surface-inverse" size={24} />
          </div>
          <h1 className="text-4xl font-black text-ink tracking-tighter label-plain italic leading-none">
            Lock-In
          </h1>
        </div>
        <p className="text-ink/60 font-bold leading-tight label-plain text-xs tracking-wider">
          {view === "login" && <>{t("login.subtitle")}{t("login.protocol") && <><br />{t("login.protocol")}</>}</>}
          {view === "register" && <>{t("login.subtitle")}{t("login.protocolRegister") && <><br />{t("login.protocolRegister")}</>}</>}
          {view === "forgot" && <>{t("login.subtitleForgot")}{t("login.protocolForgot") && <><br />{t("login.protocolForgot")}</>}</>}
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
                className="flex flex-col items-center gap-4 p-6 bg-success-50 border-auth border-success rounded-auth-card shadow-[shadow:var(--shadow-ok)]"
              >
                <CheckCircle size={32} className="text-success" />
                <p className="text-center text-success-700 font-black text-sm label-plain tracking-wider">
                  Reset link dispatched.<br />Check your inbox, Operator.
                </p>
              </motion.div>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 mb-1">
                    <Mail size={14} className="text-ink" />
                    <span className="text-[10px] font-black label-plain text-ink/40 tracking-widest">{t("login.email")}</span>
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
                  <div className="p-3 bg-danger-100 border-1 border-danger-soft text-danger-600 text-[10px] font-black label-plain tracking-wider">
                    ⚠ {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isLoading}
                  className="group relative bg-highlight border-2 border-ink rounded-auth-field p-5 shadow-[shadow:var(--shadow-4)] hover:shadow-[shadow:var(--shadow-2)] hover:translate-x-[4px] hover:translate-y-[4px] active:shadow-none active:translate-x-[8px] active:translate-y-[8px] transition-all disabled:opacity-50 mt-2"
                >
                  <div className="flex items-center justify-center gap-3">
                    <RotateCcw className="text-ink" size={18} />
                    <span className="text-lg font-black text-highlight-ink label-plain tracking-wider">
                      {isLoading ? t("login.sending") : t("login.sendReset")}
                    </span>
                  </div>
                </button>
              </>
            )}

            <button
              type="button"
              onClick={() => resetForm("login")}
              className="flex items-center justify-center gap-2 text-[10px] font-black text-ink/40 label-action-plain tracking-[0.2em] hover:text-ink transition-colors mt-2"
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
                    <User size={14} className="text-ink" />
                    <span className="text-[10px] font-black label-plain text-ink/40 tracking-widest">{t("login.handle")}</span>
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
                <Mail size={14} className="text-ink" />
                <span className="text-[10px] font-black label-plain text-ink/40 tracking-widest">{t("login.email")}</span>
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
                <Key size={14} className="text-ink" />
                <span className="text-[10px] font-black label-plain text-ink/40 tracking-widest">{t("login.password")}</span>
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
                className="self-end text-[10px] font-black text-ink/40 label-action-plain tracking-[0.15em] hover:text-ink transition-colors -mt-2"
              >
                {t("login.forgot")}
              </button>
            )}

            {/* Error Banner */}
            {error && (
              <div className="p-3 bg-danger-100 border-1 border-danger-soft text-danger-600 text-[10px] font-black label-plain tracking-wider">
                ⚠ {error}
              </div>
            )}

            {/* Submit */}
            <button
              id="auth-submit"
              type="submit"
              disabled={isLoading}
              className="group relative bg-highlight border-2 border-ink rounded-auth-field p-5 shadow-[shadow:var(--shadow-4)] hover:shadow-[shadow:var(--shadow-2)] hover:translate-x-[4px] hover:translate-y-[4px] active:shadow-none active:translate-x-[8px] active:translate-y-[8px] transition-all disabled:opacity-50 mt-4"
            >
              <div className="flex items-center justify-center gap-3">
                <Zap className="text-highlight-ink group-hover:animate-pulse" size={20} />
                <span className="text-lg font-black text-highlight-ink label-plain tracking-wider">
                  {isLoading ? t("login.submitting") : view === "register" ? t("login.register") : t("login.submit")}
                </span>
              </div>
            </button>

            {/* Toggle login ↔ register */}
            <button
              type="button"
              onClick={() => resetForm(view === "login" ? "register" : "login")}
              className="text-center text-[10px] font-black text-ink/40 label-action-plain tracking-[0.2em] hover:text-ink transition-colors mt-2"
            >
              {view === "register" ? t("login.toLogin") : t("login.toRegister")}
            </button>

            {/* Footer badges */}
            <div className="flex items-center justify-center gap-6 mt-4">
              <div className="flex items-center gap-2 text-ink/40 font-black text-[10px] label-sm">
                <Shield size={12} />
                <span>{t("login.encrypted")}</span>
              </div>
              <div className="w-px h-4 bg-ink/10" />
              <div className="text-ink/40 font-black text-[10px] label-sm">
                {appVersion}
              </div>
            </div>
          </motion.form>
        )}
      </AnimatePresence>

      {/* DECORATIVE BACKGROUND TEXT */}
      <div className="fixed bottom-12 left-12 opacity-5 transform -rotate-12 pointer-events-none select-none">
        <h2 className="text-8xl font-black text-ink leading-none label-plain">{t("watermark.left")}</h2>
      </div>
      <div className="fixed top-12 right-12 opacity-5 transform rotate-12 pointer-events-none select-none">
        <h2 className="text-8xl font-black text-ink leading-none label-plain">{t("watermark.right")}</h2>
      </div>
    </div>
  );
}
