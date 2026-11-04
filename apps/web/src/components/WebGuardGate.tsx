import { invoke } from "@tauri-apps/api/core";
import { reportWriteFailure } from "../writeFailures";

type Props = {
  storeUrl: string;
  /** Web Guard isn't answering (online). Otherwise: other browsers are open. */
  webGuardQuiet: boolean;
  /** Browsers lockdown would close right now, by name. */
  closable: string[];
  /** False if the heartbeat port couldn't open: lockdown would close everything. */
  canLockDown: boolean;
  /** Browsers that keep running with Web Guard, but not in Incognito. */
  incognitoGaps: string[];
  onStartLockdown: () => void;
  onStartAppsOnly: () => void;
  onStartAnyway: () => void;
  onClose: () => void;
};

function list(names: string[]): string {
  if (names.length < 2) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const primary = "w-full bg-ink text-surface-inverse py-3 rounded-lg font-black text-[10px] label-action-sm";
const secondary = "w-full bg-surface border-1 border-ink text-ink py-3 rounded-lg font-black text-[10px] label-action-sm";

/**
 * Shown when a session that blocks websites is started and something can't be
 * blocked: Web Guard is quiet, or another known browser is open. It says what the
 * session can't do and lets the operator choose.
 */
export function WebGuardGate({
  storeUrl,
  webGuardQuiet,
  closable,
  canLockDown,
  incognitoGaps,
  onStartLockdown,
  onStartAppsOnly,
  onStartAnyway,
  onClose,
}: Props) {
  const install = () => {
    invoke("open_web_guard_store")
      .then(onClose)
      .catch((err) =>
        reportWriteFailure(`Couldn't open Chrome. Install Web Guard from ${storeUrl}`, err)
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
          {webGuardQuiet ? "Web Guard isn't answering" : "Other browsers are open"}
        </h2>
        <p className="text-sm font-bold text-ink/70 mb-3">
          {webGuardQuiet
            ? "This session blocks websites, and Web Guard is what blocks them. Without it, Lock-In can still close your blocked apps, but it can't block sites."
            : `This session blocks websites, but Lock-In can't block them in ${list(closable)}.`}
        </p>
        {canLockDown && (
          <p className="text-xs font-bold text-ink/70 mb-3">
            Closing other browsers: {closable.length > 0 ? `${list(closable)} and any` : "any"} browser
            without Web Guard close{closable.length > 0 ? "" : "s"} after a 10 second warning, and again if
            reopened. Unsaved typing in them is lost.
          </p>
        )}
        {incognitoGaps.length > 0 && (
          <p className="text-xs font-bold text-ink/70 mb-3">
            Incognito windows in {list(incognitoGaps)} aren't blocked unless you allow Web Guard there.
          </p>
        )}
        <div className="flex flex-col gap-2 mt-2">
          {canLockDown && (
            <button onClick={onStartLockdown} className={primary}>
              Start and close other browsers
            </button>
          )}
          {webGuardQuiet ? (
            <>
              <button onClick={install} className={canLockDown ? secondary : primary}>
                Install Web Guard
              </button>
              <button onClick={onStartAppsOnly} className={secondary}>
                Start apps-only
              </button>
            </>
          ) : (
            <button onClick={onStartAnyway} className={secondary}>
              Start and leave them open
            </button>
          )}
          <button onClick={onClose} className="w-full py-2 text-[10px] font-bold text-ink/60 underline">
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
