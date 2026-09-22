import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Mail, RefreshCw, CheckCircle, LogOut, AlertTriangle } from "lucide-react";

interface VerificationGateProps {
  email: string;
  onCheckStatus: () => Promise<boolean>;
  onResend: () => Promise<void>;
  onLogout: () => void;
  /** The verification email sent at registration failed. */
  sendFailed?: boolean;
}

export function VerificationGate({
  email,
  onCheckStatus,
  onResend,
  onLogout,
  sendFailed = false,
}: VerificationGateProps) {
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(false);
  const [resendSuccess, setResendSuccess] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: "error" | "info"; text: string } | null>(null);

  // Registration's verification email failed to send: say so, rather than
  // waiting for an email that isn't coming. Resend is right below.
  useEffect(() => {
    if (sendFailed) {
      setStatusMsg({
        type: "error",
        text: "We couldn't send your verification email. Use Resend below to try again.",
      });
    }
  }, [sendFailed]);

  const handleCheckStatus = async () => {
    setChecking(true);
    setStatusMsg(null);
    try {
      const verified = await onCheckStatus();
      if (!verified) {
        setStatusMsg({
          type: "info",
          text: "Comm link not yet confirmed. Click the link in your inbox first.",
        });
      }
      // If verified = true, App.tsx will unmount this gate automatically
    } catch (err: any) {
      setStatusMsg({ type: "error", text: "Status check failed. Try again." });
    } finally {
      setChecking(false);
    }
  };

  const handleResend = async () => {
    if (resendCooldown) return;
    setSending(true);
    setStatusMsg(null);
    try {
      await onResend();
      setResendSuccess(true);
      setResendCooldown(true);
      // 60-second cooldown before they can resend again
      setTimeout(() => setResendCooldown(false), 60_000);
    } catch (err: any) {
      setStatusMsg({ type: "error", text: "Could not resend link. Wait a moment and retry." });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="h-screen bg-[#F9F8F4] flex flex-col items-center [justify-content:safe_center] p-8 font-outfit overflow-y-auto">

      {/* ── Background watermarks ── */}
      <div className="fixed bottom-12 left-12 opacity-5 transform -rotate-12 pointer-events-none select-none">
        <span className="text-8xl font-black text-[#002855] leading-none uppercase">LOCKED</span>
      </div>
      <div className="fixed top-12 right-12 opacity-5 transform rotate-12 pointer-events-none select-none">
        <span className="text-8xl font-black text-[#002855] leading-none uppercase">VERIFY</span>
      </div>

      {/* ── Header badge ── */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-[440px] bg-[#002855] border-[4px] border-[#002855] p-8 shadow-[8px_8px_0px_#002855] mb-8 transform -rotate-1"
      >
        <div className="flex items-center gap-4 mb-4">
          <div className="w-12 h-12 bg-[#FFD166] flex items-center justify-center">
            <Mail className="text-[#002855]" size={24} />
          </div>
          <div>
            <p className="text-[9px] font-black uppercase tracking-[0.3em] text-white/40 mb-1">
              Protocol: COMM_VERIFICATION
            </p>
            <h1 className="text-2xl font-black text-white tracking-tighter uppercase leading-tight">
              Comm Link Pending<br />Verification
            </h1>
          </div>
        </div>
        <div className="h-px bg-white/10 my-4" />
        <p className="text-white/50 font-bold text-xs leading-relaxed uppercase tracking-wider">
          A verification dispatch was sent to:
        </p>
        <p className="text-[#FFD166] font-black text-sm mt-1 break-all">{email}</p>
      </motion.div>

      {/* ── Instructions card ── */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.1 }}
        className="w-full max-w-[440px] bg-white border-[3px] border-[#002855] p-6 shadow-[6px_6px_0px_#002855] mb-6"
      >
        <div className="flex items-start gap-4">
          <AlertTriangle size={20} className="text-[#FFD166] shrink-0 mt-0.5" />
          <div>
            <p className="font-black text-[#002855] text-sm uppercase tracking-wide mb-2">
              Action Required
            </p>
            <ol className="flex flex-col gap-2">
              {[
                "Open the email from Firebase / Lock-In.",
                "Click the verification link inside.",
                "Return here and hit \"Check Status\".",
              ].map((step, i) => (
                <li key={i} className="flex items-start gap-3 text-[#002855]/60 font-bold text-xs">
                  <span className="shrink-0 w-5 h-5 bg-[#002855] text-white font-black text-[10px] flex items-center justify-center">
                    {i + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ol>
          </div>
        </div>
      </motion.div>

      {/* ── Status message ── */}
      <AnimatePresence>
        {statusMsg && (
          <motion.div
            key="status"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className={`w-full max-w-[440px] p-3 border-2 text-[10px] font-black uppercase tracking-wider mb-4 ${
              statusMsg.type === "error"
                ? "bg-red-100 border-red-500 text-red-600"
                : "bg-blue-50 border-[#002855] text-[#002855]"
            }`}
          >
            ⚠ {statusMsg.text}
          </motion.div>
        )}

        {resendSuccess && (
          <motion.div
            key="resent"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="w-full max-w-[440px] flex items-center gap-3 p-3 bg-green-50 border-2 border-green-600 text-green-700 text-[10px] font-black uppercase tracking-wider mb-4"
          >
            <CheckCircle size={14} />
            New link dispatched. Check your inbox.
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Action buttons ── */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.2 }}
        className="w-full max-w-[440px] flex flex-col gap-4"
      >
        {/* Primary: Check Status */}
        <button
          id="verify-check-status"
          onClick={handleCheckStatus}
          disabled={checking}
          className="group relative bg-[#FFD166] border-[4px] border-[#002855] p-5 shadow-[8px_8px_0px_#002855] hover:shadow-[4px_4px_0px_#002855] hover:translate-x-[4px] hover:translate-y-[4px] active:shadow-none active:translate-x-[8px] active:translate-y-[8px] transition-all disabled:opacity-50"
        >
          <div className="flex items-center justify-center gap-3">
            <RefreshCw
              className={`text-[#002855] ${checking ? "animate-spin" : "group-hover:rotate-180 transition-transform duration-500"}`}
              size={20}
            />
            <span className="text-lg font-black text-[#002855] uppercase tracking-wider">
              {checking ? "Checking..." : "Check Status"}
            </span>
          </div>
        </button>

        {/* Secondary: Resend */}
        <button
          id="verify-resend"
          onClick={handleResend}
          disabled={sending || resendCooldown}
          className="border-[3px] border-[#002855] bg-white p-4 shadow-[4px_4px_0px_#002855] hover:shadow-[2px_2px_0px_#002855] hover:translate-x-[2px] hover:translate-y-[2px] active:shadow-none transition-all disabled:opacity-40"
        >
          <div className="flex items-center justify-center gap-3">
            <Mail className="text-[#002855]" size={16} />
            <span className="font-black text-[#002855] text-sm uppercase tracking-wider">
              {sending ? "Sending..." : resendCooldown ? "Link Sent — Wait 60s" : "Resend Verification Link"}
            </span>
          </div>
        </button>

        {/* Tertiary: Sign Out */}
        <button
          id="verify-logout"
          onClick={onLogout}
          className="flex items-center justify-center gap-2 text-[10px] font-black text-[#002855]/30 uppercase tracking-[0.2em] hover:text-[#002855] transition-colors mt-2"
        >
          <LogOut size={12} />
          Sign Out — Use Different Account
        </button>
      </motion.div>
    </div>
  );
}
