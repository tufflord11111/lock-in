import { useState } from "react";
import { ref, update } from "firebase/database";
import { db } from "@lock-in/firebase";
import { guardWrite } from "../writeFailures";
import { useCopy } from "../theme/copy";

/**
 * The one number that turns "you focused 240 minutes" into evidence: what the
 * operator was losing before. Asked once per machine, answered or skipped, and
 * never asked again — a prompt that keeps coming back is a prompt people learn
 * to dismiss without reading.
 *
 * Stored as config/baselineHoursLost, which the rules bound to 0..24.
 */
const ASKED_KEY = "lockin.baselineAsked";

export function hasBeenAsked(): boolean {
  try {
    return localStorage.getItem(ASKED_KEY) === "1";
  } catch {
    // Private mode or a wiped profile: asking again is better than never asking.
    return false;
  }
}

function markAsked(): void {
  try {
    localStorage.setItem(ASKED_KEY, "1");
  } catch {
    /* nothing to do — the worst case is being asked once more */
  }
}

export function BaselineQuestion({ userId, onDone }: { userId: string; onDone: () => void }) {
  const t = useCopy();
  const [hours, setHours] = useState(3);

  const finish = (save: boolean) => {
    markAsked();
    if (save) {
      guardWrite(
        update(ref(db, `users/${userId}/config`), { baselineHoursLost: hours }),
        "Couldn't save your answer. Your sessions still count — only the comparison is missing."
      );
    }
    onDone();
  };

  return (
    <div className="fixed inset-0 z-[120] bg-shadow-ink/40 backdrop-blur-sm flex items-center justify-center p-8">
      <div className="bg-surface border-1 border-ink rounded-2xl shadow-[shadow:var(--shadow-4)] p-8 w-full max-w-[460px] flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <p className="text-[9px] font-black label-sm text-ink-muted">{t("baseline.eyebrow")}</p>
          <h2 className="text-xl font-bold text-ink tracking-tight leading-snug">{t("baseline.question")}</h2>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-baseline gap-2">
            <span className="text-5xl font-black text-ink tabular-nums leading-none">{hours}</span>
            <span className="text-sm font-bold text-ink-muted">{t("baseline.unit")}</span>
          </div>
          <input
            type="range"
            min={0}
            max={12}
            step={1}
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
            aria-label={t("baseline.question") ?? "Hours lost per day"}
            className="w-full accent-accent"
          />
          <div className="flex justify-between text-[9px] font-bold text-ink-muted label-action-sm">
            <span>0</span>
            <span>12</span>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={() => finish(true)}
            className="flex-1 bg-ink text-surface-inverse py-4 rounded-xl text-xs font-black label-action-sm border-1 border-ink shadow-[shadow:var(--shadow-2)] active:translate-y-[2px] active:shadow-none transition-all"
          >
            {t("baseline.save")}
          </button>
          <button
            onClick={() => finish(false)}
            className="px-5 py-4 rounded-xl text-xs font-bold text-ink-muted hover:text-ink transition-colors"
          >
            {t("baseline.skip")}
          </button>
        </div>
      </div>
    </div>
  );
}
