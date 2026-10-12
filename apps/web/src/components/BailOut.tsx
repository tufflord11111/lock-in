import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { HoldButton } from "./HoldButton";
import { useCopy } from "../theme/copy";
import { logUiEvent } from "../uiEventLog";

type BailoutResult = {
  armed: boolean;
  deadline: number | null;
  refused: string | null;
  remaining_ms: number | null;
};

type EnforcerPeek = {
  focus_active: boolean;
  bailout_deadline: number | null;
  bailout_used_date: string | null;
  bailout_fuse_ms: number;
};

const isTauri =
  typeof window !== "undefined" &&
  !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

/** mm:ss from milliseconds, floored at 0:00. */
function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const today = () => new Date().toLocaleDateString("en-CA");

/** "5 minutes" / "30 seconds" — the fuse length, said the way a person would. */
function humanFuse(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} seconds`;
  const mins = Math.round(ms / 60_000);
  return mins === 1 ? "1 minute" : `${mins} minutes`;
}

/**
 * The escape hatch, on a fuse.
 *
 * Bailing out does not stop the session — it schedules its end a few minutes
 * out and voids it. Rust owns the deadline and the countdown here only renders
 * what Rust already decided, so quitting the app, signing out or editing the
 * clock cannot bring the end forward. There is no cancel: a fuse you can put
 * out is not a commitment.
 */
export function BailOut({ userId, className = "" }: { userId?: string; className?: string }) {
  const t = useCopy();
  const [deadline, setDeadline] = useState<number | null>(null);
  const [usedToday, setUsedToday] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [refusal, setRefusal] = useState<string | null>(null);
  /** What Rust says a fuse armed now would burn for — DEV_MODE shortens it. */
  const [fuseMs, setFuseMs] = useState(5 * 60 * 1000);

  // Rust is the only source of truth for the fuse; poll it rather than keep a
  // second copy that could disagree after a restart or a sign-out.
  const peek = useCallback(async () => {
    if (!isTauri) return;
    try {
      const state = await invoke<EnforcerPeek>("get_enforcer_state");
      setDeadline(state.bailout_deadline ?? null);
      setUsedToday(state.bailout_used_date === today());
      if (typeof state.bailout_fuse_ms === "number") setFuseMs(state.bailout_fuse_ms);
    } catch {
      /* state unknown — the disarm panel owns that case, not this one */
    }
  }, []);

  useEffect(() => {
    void peek();
    const id = window.setInterval(() => {
      setNow(Date.now());
      void peek();
    }, 1000);
    return () => window.clearInterval(id);
  }, [peek]);

  const arm = useCallback(async () => {
    if (!isTauri) return;
    setRefusal(null);
    try {
      const res = await invoke<BailoutResult>("arm_bailout", { localDate: today() });
      if (res.armed) {
        setDeadline(res.deadline ?? null);
        setUsedToday(true);
        logUiEvent("bailout-armed", userId);
        return;
      }
      if (res.refused === "already-burning") setDeadline(res.deadline ?? null);
      else setRefusal(res.refused);
      await peek();
    } catch (err) {
      console.error("[LOCK-IN] arm_bailout failed:", err);
    }
  }, [peek, userId]);

  const burning = deadline !== null && deadline > now;

  if (burning) {
    return (
      <div className={`flex flex-col items-center gap-1 ${className}`} role="status">
        <p className="text-sm font-black text-danger tabular-nums">
          {t("bailout.counting", { remaining: clock(deadline - now) })}
        </p>
        <p className="text-[10px] font-bold text-ink-muted text-center leading-snug">
          {t("bailout.countingSub")}
        </p>
      </div>
    );
  }

  if (usedToday || refusal === "used-today") {
    return (
      <p className={`text-[10px] font-bold text-ink-muted text-center leading-snug ${className}`} role="status">
        {t("bailout.usedToday")}
      </p>
    );
  }

  return (
    <div className={`flex flex-col items-center gap-2 ${className}`}>
      <HoldButton
        onComplete={arm}
        ariaLabel={t("bailout.confirm") ?? "Hold to bail out"}
        className="w-full py-3 rounded-xl border-1 border-danger text-danger text-[11px] font-black label-action-sm"
        fillClassName="bg-danger/20"
      >
        {t("bailout.hold")}
      </HoldButton>
      <p className="text-[10px] font-bold text-ink-muted text-center leading-snug">
        {t("bailout.explain", { fuse: humanFuse(fuseMs) })}
      </p>
    </div>
  );
}
