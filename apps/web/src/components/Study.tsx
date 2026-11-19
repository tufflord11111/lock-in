import { useEffect, useState } from "react";
import { onValue, ref, serverTimestamp, set } from "firebase/database";
import { db } from "@lock-in/firebase";
import { awaitWriteOrQueue } from "../offlineWrite";
import { reportWriteFailure } from "../writeFailures";
import { useCopy } from "../theme/copy";
import {
  CONSENT_TEXT, FOLLOWUP_EYEBROW, STUDY_ROW_TITLE, followupDue, followupSkipped, markFollowupSkipped,
  type StudyState,
} from "../study";

/** The account's study answers, live. */
export function useStudyState(userId: string | null): StudyState | null {
  const [state, setState] = useState<StudyState | null>(null);
  useEffect(() => {
    if (!userId) return;
    return onValue(ref(db, `users/${userId}/config`), (snap) => {
      const c = snap.val() ?? {};
      setState({
        consented: c.study?.consented === true,
        consentedAt: typeof c.study?.consentedAt === "number" ? c.study.consentedAt : undefined,
        baselineHoursLost: typeof c.baselineHoursLost === "number" ? c.baselineHoursLost : undefined,
        followupAnswered: c.followupHoursLost != null,
      });
    });
  }, [userId]);
  return state;
}

/** Settings: the switch, off unless turned on, with the consent text in full. */
export function StudyConsentRow({ userId }: { userId: string }) {
  const study = useStudyState(userId);
  const on = study?.consented === true;
  const toggle = () => {
    const next = !on;
    awaitWriteOrQueue(set(ref(db, `users/${userId}/config/study`), { consented: next, consentedAt: serverTimestamp(), v: 1 }), {
      lateErrorMessage: "Couldn't save that choice. Try again when you're online.",
    }).catch(() => reportWriteFailure("Couldn't save that choice. Try again when you're online."));
  };
  return (
    <section className="w-full bg-surface-alt border-1 border-ink-2 p-6 rounded-2xl shadow-[4px_4px_0px_var(--ink-2)] flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm font-black text-ink label-plain tracking-tight">{STUDY_ROW_TITLE}</p>
        <button
          onClick={toggle}
          role="switch"
          aria-checked={on}
          aria-label={STUDY_ROW_TITLE}
          disabled={study === null}
          className={`shrink-0 px-4 py-2 rounded-lg text-[10px] font-black label-action-sm border-1 ${on ? "bg-ink text-surface-inverse border-ink" : "bg-surface text-ink border-ink/30"}`}
        >
          {on ? "On" : "Off"}
        </button>
      </div>
      <p className="text-[11px] font-bold text-ink/60 leading-relaxed">{CONSENT_TEXT}</p>
    </section>
  );
}

/**
 * The day-14 question: the baseline question again, same words, same 0-12
 * slider, once. Shown in the baseline card's slot, never during a session.
 */
export function StudyFollowup({ userId, isActive, otherCard }: { userId: string; isActive: boolean; otherCard: boolean }) {
  const t = useCopy();
  const study = useStudyState(userId);
  const [skipped, setSkipped] = useState(() => followupSkipped());
  const [done, setDone] = useState(false);
  const [hours, setHours] = useState(3);
  const [askedAt] = useState(() => Date.now());
  if (done || !study || !followupDue(study, Date.now(), { isActive, otherCard, skipped })) return null;

  const save = () => {
    setDone(true);
    awaitWriteOrQueue(
      set(ref(db, `users/${userId}/config/followupHoursLost`), { value: hours, askedAt, answeredAt: serverTimestamp() }),
      { lateErrorMessage: "Couldn't save your answer." }
    ).catch(() => reportWriteFailure("Couldn't save your answer."));
  };
  const skip = () => {
    markFollowupSkipped();
    setSkipped(true);
  };

  return (
    <div className="fixed inset-0 z-[120] bg-shadow-ink/40 backdrop-blur-sm flex items-center justify-center p-8">
      <div className="bg-surface border-1 border-ink rounded-2xl shadow-[shadow:var(--shadow-4)] p-8 w-full max-w-[460px] flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <p className="text-[9px] font-black label-sm text-ink-muted">{FOLLOWUP_EYEBROW}</p>
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
            onClick={save}
            className="flex-1 bg-ink text-surface-inverse py-4 rounded-xl text-xs font-black label-action-sm border-1 border-ink shadow-[shadow:var(--shadow-2)] active:translate-y-[2px] active:shadow-none transition-all"
          >
            {t("baseline.save")}
          </button>
          <button onClick={skip} className="px-5 py-4 rounded-xl text-xs font-bold text-ink-muted hover:text-ink transition-colors">
            {t("baseline.skip")}
          </button>
        </div>
      </div>
    </div>
  );
}
