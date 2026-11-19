import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { HoldButton } from "./HoldButton";
import { useCopy } from "../theme/copy";
import { logUiEvent } from "../uiEventLog";
import { ref, set } from "firebase/database";
import { db } from "@lock-in/firebase";
import { bailoutEndFor, isPermissionDenied } from "../hooks/b2";
import { serverNow, serverOffset } from "../serverTime";

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

/**
 * Tell Web Guard and the rules when the fuse burns down (1.3.1 B2), in server
 * time. The rules take it once, and only at least 4.5 minutes out; a write that
 * arrived late (queued offline) is refused, so it is sent once more from the
 * server's now. Rust's own fuse is unaffected either way.
 */
async function writeBailoutEnd(uid: string, bailoutEnd: number, deadline: number): Promise<void> {
  const at = ref(db, `users/${uid}/sessionState/bailoutEnd`);
  try {
    await set(at, bailoutEnd);
  } catch (err) {
    if (!isPermissionDenied(err)) return console.warn("[LOCK-IN] bailoutEnd write failed:", err);
    await set(at, serverNow() + Math.max(0, deadline - Date.now()) + 1_000).catch((e) =>
      console.warn("[LOCK-IN] bailoutEnd refused twice; sites stay blocked until the session's end:", e)
    );
  }
}

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
 * what Rust already decided, so quitting the app or signing out does not bring
 * the end forward. The deadline is wall-clock time, though: moving the Windows
 * clock forward does end the fuse, and any session, early. There is no cancel:
 * a fuse you can put out is not a commitment.
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
      const res = await invoke<BailoutResult>("arm_bailout") /* Rust uses this PC's local date (1.3.1 H2) */;
      if (res.armed) {
        setDeadline(res.deadline ?? null);
        setUsedToday(true);
        logUiEvent("bailout-armed", userId);
        if (userId && typeof res.deadline === "number") void writeBailoutEnd(userId, bailoutEndFor(res.deadline, serverOffset()), res.deadline);
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
