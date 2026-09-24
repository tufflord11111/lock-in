import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Mirrors the Rust EnforcerState struct (serde emits these names as declared). */
export type EnforcerState = {
  is_locked: boolean;
  focus_active: boolean;
  exe_blacklist_len: number;
  permanent_exe_len: number;
  /** Session app names awaiting local approval (G1). Not enforced. */
  exe_pending: string[];
  /** Permanent block names awaiting local approval (F4). Not enforced. */
  permanent_pending: string[];
  disarm_latch: boolean;
  /** Epoch ms deadline of the running session, or null when none is armed. */
  session_end_time: number | null;
};

type Props = {
  /**
   * When the probe itself fails, treat the enforcer as armed and show the
   * control anyway. Correct on the degraded boot screen — a trapped operator
   * with no button is worse than a spare button. Wrong on the Login screen,
   * where a normal signed-out user must not see it (X2).
   */
  failOpen?: boolean;
  /**
   * "inline" — the bare control, for a column that already frames it.
   * "card"   — self-framed with a heading, for screens where a red button
   *            would otherwise appear out of nowhere.
   */
  variant?: "inline" | "card";
  className?: string;
};

/**
 * EMERGENCY DISARM — the operator's escape hatch from a running enforcer.
 *
 * Shared by the degraded boot screen and the Login screen. It talks ONLY to
 * Rust (get_enforcer_state / clear_all_blocks): no auth, no Firebase, no
 * React session state. That is the point — the cases where it is needed are
 * exactly the cases where auth is broken and every Firebase-derived flag is
 * stale or absent. Renders nothing unless the enforcer is actually armed.
 */
export function EnforcerDisarmPanel({
  failOpen = false,
  variant = "inline",
  className = "",
}: Props) {
  const [enforcer, setEnforcer] = useState<EnforcerState | null>(null);
  const [stateUnknown, setStateUnknown] = useState(false);
  const [disarming, setDisarming] = useState(false);
  const [disarmed, setDisarmed] = useState(false);
  const [confirmedState, setConfirmedState] = useState<EnforcerState | null>(null);
  const [disarmError, setDisarmError] = useState<string | null>(null);
  /** Why the probe failed, if it did. Rendered inline — devtools are off in
   *  shipped builds, so a console line alone would be invisible. */
  const [probeError, setProbeError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const probe = async (attempt: number) => {
      try {
        const s = await invoke<EnforcerState>("get_enforcer_state");
        if (cancelled) return;
        // Logged on success too: without this, "not armed" and "probe failed"
        // were indistinguishable from outside.
        console.info(`[LOCK-IN] disarm panel state: ${JSON.stringify(s)}`);
        setEnforcer(s);
        setStateUnknown(false);
        setProbeError(null);
      } catch (err) {
        if (cancelled) return;
        if (attempt === 0) {
          // Early-boot IPC race: if this mounts before Tauri is ready, invoke
          // can reject. One retry after 1 s before giving up.
          console.warn(`[LOCK-IN] disarm panel (${variant}) probe failed, retrying in 1 s:`, err);
          setTimeout(() => probe(1), 1000);
          return;
        }
        console.error(`[LOCK-IN] disarm panel probe FAILED: ${String(err)}`, {
          variant,
          failOpen,
          err,
        });
        setProbeError(String(err));
        setStateUnknown(true);
      }
    };
    probe(0);
    return () => {
      cancelled = true;
    };
  }, []);

  // Rust state ONLY. React/Firebase session flags are useless here: after a
  // degraded boot or on the Login screen, `isActive` is false while the Rust
  // enforcer may be armed from disk — exactly when the operator is trapped.
  // permanent_exe is included so the escape is reachable when a disarm-proof
  // permanent block is the ONLY thing running.
  const armed =
    (failOpen && stateUnknown) ||
    (enforcer !== null &&
      (enforcer.is_locked ||
        enforcer.focus_active ||
        enforcer.exe_blacklist_len > 0 ||
        enforcer.permanent_exe_len > 0));

  if (!armed) return null;

  const handleDisarm = async () => {
    setDisarming(true);
    setDisarmError(null);
    try {
      // clear_all_blocks wipes session AND permanent blocks (F1/F2).
      await invoke<string>("clear_all_blocks");
      setDisarmed(true);
      try {
        const after = await invoke<EnforcerState>("get_enforcer_state");
        setConfirmedState(after);
      } catch (e) {
        setDisarmError(`Disarm sent, but state could not be re-read: ${String(e)}`);
      }
    } catch (err) {
      // Inline, not console.error — there are no devtools on a shipped build.
      setDisarmError(String(err));
    } finally {
      setDisarming(false);
    }
  };

  const control = (
    <div className="flex flex-col gap-2">
      {/* Let the operator judge whether waiting out the session is an option
          before they reach for the escape hatch. */}
      {enforcer?.session_end_time != null && !disarmed && (
        <p className="text-[10px] font-black text-navy/60 uppercase tracking-widest mb-1">
          Session ends at{" "}
          {new Date(enforcer.session_end_time).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      )}

      {disarmed ? (
        <div className="flex flex-col gap-2">
          <div className="px-6 py-3 bg-success-solid text-white font-black text-[10px] uppercase tracking-widest rounded-xl border-2 border-success-edge">
            All Blocks Cleared
          </div>
          {confirmedState && (
            <p className="text-[9px] font-bold text-navy/50 uppercase tracking-wide leading-relaxed">
              Confirmed — locked: {String(confirmedState.is_locked)} · focus:{" "}
              {String(confirmedState.focus_active)} · session targets:{" "}
              {confirmedState.exe_blacklist_len} · permanent blocks:{" "}
              {confirmedState.permanent_exe_len}
            </p>
          )}
        </div>
      ) : (
        <button
          onClick={handleDisarm}
          disabled={disarming}
          className="px-6 py-3 bg-danger text-white font-black text-[10px] uppercase tracking-widest rounded-xl border-2 border-danger-2 shadow-[2px_2px_0px_var(--danger-2)] hover:-translate-y-0.5 active:translate-y-0 active:shadow-none transition-all disabled:opacity-50"
        >
          {disarming
            ? "Clearing..."
            : stateUnknown
              ? "Clear All Blocks (State Unknown)"
              : "Clear All Blocks"}
        </button>
      )}

      <p className="text-[9px] font-bold text-navy/40 uppercase tracking-wide leading-relaxed">
        Ends the session, unblocks Task Manager, and clears ALL blocks — including
        permanent 24/7 blocks. Nothing re-arms until you start a new session.
      </p>

      {probeError && (
        <p className="text-[9px] font-bold text-danger tracking-wide leading-relaxed break-words text-left bg-danger/5 border border-danger/20 rounded-lg p-2">
          Enforcer state could not be read: {probeError}
        </p>
      )}

      {disarmError && (
        <p className="text-[9px] font-bold text-danger tracking-wide leading-relaxed break-words text-left bg-danger/5 border border-danger/20 rounded-lg p-2">
          {disarmError}
        </p>
      )}
    </div>
  );

  if (variant === "card") {
    return (
      <div
        className={`w-full bg-white border-[4px] border-danger p-6 shadow-[8px_8px_0px_var(--danger-2)] ${className}`}
      >
        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-danger mb-3">
          Enforcer is running on this machine
        </p>
        {control}
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-2 mt-2 pt-4 border-t-2 border-navy/10 ${className}`}>
      {control}
    </div>
  );
}
