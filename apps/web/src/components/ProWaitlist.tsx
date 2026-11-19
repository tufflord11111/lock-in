import { useState } from "react";
import { ref, set } from "firebase/database";
import { db } from "@lock-in/firebase";
import { awaitWriteOrQueue } from "../offlineWrite";
import { reportWriteFailure } from "../writeFailures";
import { useCopy } from "../theme/copy";
import {
  PRO_FEATURES, PRO_PRICES, markProAsked, proRecord, saveProInterestLocally, savedProInterest,
} from "../proWaitlist";

/**
 * "Lock-In Pro is not built yet": a waitlist, nothing more. No price, no
 * checkout. Everything free today stays free (the body says what). Shown once
 * per machine after the first completed session, and from Settings.
 */
export function ProWaitlist({ userId, onDone }: { userId: string; onDone: () => void }) {
  const t = useCopy();
  const [features, setFeatures] = useState<string[]>([]);
  const [price, setPrice] = useState<string | null>(null);
  const [saved, setSaved] = useState(() => savedProInterest() !== null);

  const close = () => {
    markProAsked();
    onDone();
  };

  const notify = () => {
    const rec = proRecord({ notify: true, price, features }, Date.now());
    saveProInterestLocally(rec);
    markProAsked();
    setSaved(true);
    awaitWriteOrQueue(set(ref(db, `users/${userId}/proInterest`), rec), {
      lateErrorMessage: "Couldn't send your Pro answer. It's saved on this PC.",
    }).catch(() => reportWriteFailure("Couldn't send your Pro answer. It's saved on this PC."));
  };

  const toggle = (f: string) => setFeatures((prev) => (prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f]));

  return (
    <div className="fixed inset-0 z-[120] bg-shadow-ink/40 backdrop-blur-sm flex items-center justify-center p-8">
      <div className="bg-surface border-1 border-ink rounded-2xl shadow-[shadow:var(--shadow-4)] p-8 w-full max-w-[480px] flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <p className="text-[9px] font-black label-sm text-ink-muted">{t("pro.eyebrow")}</p>
          <h2 className="text-xl font-bold text-ink tracking-tight leading-snug">{t("pro.title")}</h2>
          <p className="text-sm font-bold text-ink/70 leading-relaxed">{t("pro.body")}</p>
        </div>

        {saved ? (
          <p className="text-sm font-black text-ink">{t("pro.notified")}</p>
        ) : (
          <>
            <fieldset className="flex flex-col gap-2">
              <legend className="text-xs font-bold text-ink-muted mb-1">{t("pro.featuresQ")}</legend>
              {PRO_FEATURES.map((f) => (
                <label key={f} className="flex items-center gap-2 text-sm font-bold text-ink">
                  <input type="checkbox" checked={features.includes(f)} onChange={() => toggle(f)} className="accent-accent" />
                  {f}
                </label>
              ))}
            </fieldset>
            <fieldset className="flex flex-col gap-2">
              <legend className="text-xs font-bold text-ink-muted mb-1">{t("pro.priceQ")}</legend>
              <div className="flex flex-wrap gap-2">
                {PRO_PRICES.map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={price === p}
                    onClick={() => setPrice(price === p ? null : p)}
                    className={`px-3 py-2 rounded-lg text-xs font-black border-1 ${price === p ? "bg-ink text-surface-inverse border-ink" : "bg-surface text-ink border-ink/30"}`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </fieldset>
          </>
        )}

        <div className="flex gap-3">
          {!saved && (
            <button
              onClick={notify}
              className="flex-1 bg-ink text-surface-inverse py-4 rounded-xl text-xs font-black label-action-sm border-1 border-ink shadow-[shadow:var(--shadow-2)] active:translate-y-[2px] active:shadow-none transition-all"
            >
              {t("pro.notify")}
            </button>
          )}
          <button onClick={close} className="px-5 py-4 rounded-xl text-xs font-bold text-ink-muted hover:text-ink transition-colors">
            {t("pro.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The Settings row: opens the same card, any time. */
export function ProWaitlistRow({ userId }: { userId: string }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(() => savedProInterest() !== null);
  return (
    <section className="w-full bg-surface-alt border-1 border-ink-2 p-6 rounded-2xl shadow-[4px_4px_0px_var(--ink-2)] flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-black text-ink label-plain tracking-tight">{t("pro.settingsRow")}</p>
        {saved && <p className="text-[9px] font-bold text-ink/40 mt-1">{t("pro.notified")}</p>}
      </div>
      {!saved && (
        <button
          onClick={() => setOpen(true)}
          className="px-4 py-2 rounded-lg text-[10px] font-black label-action-sm border-1 border-ink text-ink bg-surface"
        >
          {t("pro.notify")}
        </button>
      )}
      {open && (
        <ProWaitlist
          userId={userId}
          onDone={() => {
            setOpen(false);
            setSaved(savedProInterest() !== null);
          }}
        />
      )}
    </section>
  );
}
