import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowDownCircle, X } from "lucide-react";
import type { Update } from "@tauri-apps/plugin-updater";
import type { EnforcerState } from "./EnforcerDisarmPanel";
import { reportWriteFailure } from "../writeFailures";

/**
 * 1.2.2 is the first build that can update itself, so this banner is the whole
 * update surface: check once on launch, tell the operator, and install only
 * when they say so.
 *
 * The install is gated on the Rust enforcer state, not on React's session
 * flags. A Windows install restarts the app, and a restart with a focus
 * session armed is precisely the escape hatch the enforcer exists to deny —
 * so an armed session defers the install rather than racing it. React's
 * `isActive` is not good enough here: after a degraded boot it reads false
 * while Rust is still enforcing a restored session.
 */
export function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [deferred, setDeferred] = useState(false);

  // Check exactly once per launch. check() only fetches latest.json — it
  // downloads nothing — so it is safe to run with a session armed.
  useEffect(() => {
    let alive = true;
    import("@tauri-apps/plugin-updater")
      .then(({ check }) => check())
      .then((found) => {
        if (alive && found) setUpdate(found);
      })
      .catch(() => {
        /* No updater outside Tauri, and an unreachable endpoint must never
           break the app. Staying on the current version is the safe outcome. */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!update || dismissed) return null;

  const install = async () => {
    setDeferred(false);
    setInstalling(true);
    try {
      // Rust is the authority on whether a session is armed.
      const state = await invoke<EnforcerState>("get_enforcer_state").catch(
        () => null
      );
      if (state?.focus_active) {
        setDeferred(true);
        setInstalling(false);
        return;
      }

      // On Windows the NSIS installer takes the process down itself
      // (installMode "passive"), so there is nothing to run after this.
      await update.downloadAndInstall();
    } catch (err) {
      setInstalling(false);
      reportWriteFailure(
        "The update couldn't be installed. You're still on the current version — try again, or download the installer from lockinme.com.",
        err
      );
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        className="shrink-0 flex items-center gap-4 px-10 py-3 bg-highlight-2 border-b-1 border-ink"
      >
        <ArrowDownCircle size={16} className="text-ink shrink-0" />
        <p className="text-[10px] font-black label-sm text-ink flex-1">
          Lock-In {update.version} is available — Restart to update
        </p>

        {deferred && (
          <p className="text-[9px] font-bold label-sm text-ink/60">
            Session active — updating would restart the app. It'll install when
            your session ends.
          </p>
        )}

        <button
          onClick={install}
          disabled={installing}
          className="px-4 py-2 border-1 border-ink bg-surface text-ink font-black text-[9px] label-sm shadow-[var(--shadow-1)] active:translate-y-[2px] active:shadow-none transition-all disabled:opacity-40"
        >
          {installing ? "Installing…" : "Restart to update"}
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="text-ink/40 hover:text-ink transition-colors shrink-0"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </motion.div>
    </AnimatePresence>
  );
}
