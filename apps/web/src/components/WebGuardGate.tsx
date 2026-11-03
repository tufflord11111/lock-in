import { invoke } from "@tauri-apps/api/core";
import { reportWriteFailure } from "../writeFailures";

type Props = {
  storeUrl: string;
  onStartAppsOnly: () => void;
  onClose: () => void;
};

/**
 * Shown when a session that blocks websites is started while online and the
 * extension is missing or quiet. It says what the session can't do and lets the
 * operator choose. "Start and close other browsers" joins these once browser
 * lockdown exists (docs/browser-lockdown/PHASE_A.md).
 */
export function WebGuardGate({ storeUrl, onStartAppsOnly, onClose }: Props) {
  const install = () => {
    invoke("open_web_guard_store")
      .then(onClose)
      .catch((err) =>
        reportWriteFailure(`Couldn't open your browser. Install Web Guard from ${storeUrl}`, err)
      );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="web-guard-gate-title"
        className="relative w-full max-w-md bg-surface border-1 border-ink rounded-2xl p-6 shadow-[shadow:var(--shadow-2)]"
      >
        <h2 id="web-guard-gate-title" className="text-lg font-black text-ink mb-2">
          Web Guard isn't answering
        </h2>
        <p className="text-sm font-bold text-ink/70 mb-5">
          This session blocks websites, and Web Guard is what blocks them in Chrome. Without it,
          Lock-In can still close your blocked apps, but it can't block sites.
        </p>
        <div className="flex flex-col gap-2">
          <button
            onClick={install}
            className="w-full bg-ink text-surface-inverse py-3 rounded-lg font-black text-[10px] label-action-sm"
          >
            Install Web Guard
          </button>
          <button
            onClick={onStartAppsOnly}
            className="w-full bg-surface border-1 border-ink text-ink py-3 rounded-lg font-black text-[10px] label-action-sm"
          >
            Start apps-only
          </button>
          <button onClick={onClose} className="w-full py-2 text-[10px] font-bold text-ink/60 underline">
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
