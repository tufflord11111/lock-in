import { invoke } from "@tauri-apps/api/core";
import { reportWriteFailure } from "../writeFailures";

type Props = {
  storeUrl: string;
  /** Web Guard isn't answering (online). Otherwise: other browsers are open. */
  webGuardQuiet: boolean;
  /** Browsers lockdown would close right now, by name. */
  closable: string[];
  /** The closable browsers that can run Web Guard (Chrome, Edge, Brave): installing it keeps them open. */
  installable?: { id: string; name: string }[];
  /** Closable browsers running Web Guard signed out or on another Lock-In account, by name. */
  wrongAccount?: string[];
  /** False if the heartbeat port couldn't open: lockdown would close everything, so only apps can be blocked. */
  canLockDown: boolean;
  /** Browsers that keep running with Web Guard, but not in Incognito. */
  incognitoGaps: string[];
  onStartLockdown: () => void;
  onStartAppsOnly: () => void;
  onClose: () => void;
};

function list(names: string[]): string {
  if (names.length < 2) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const primary = "w-full bg-ink text-surface-inverse py-3 rounded-lg font-black text-[10px] label-action-sm";
const secondary = "w-full bg-surface border-1 border-ink text-ink py-3 rounded-lg font-black text-[10px] label-action-sm";

/**
 * Shown when a session that blocks websites is started and it will close a
 * browser now, Web Guard is quiet, or the browser check can't run. A session that
 * blocks sites always closes browsers without Web Guard (1.3.0): there is no
 * "leave them open". The choices are to start with that, install Web Guard, or
 * block apps only.
 */
export function WebGuardGate({
  storeUrl,
  webGuardQuiet,
  closable,
  installable = [],
  wrongAccount = [],
  canLockDown,
  incognitoGaps,
  onStartLockdown,
  onStartAppsOnly,
  onClose,
}: Props) {
  // Web Guard installs into whichever browser opens the Store page, so open it in
  // the one being installed for. No id means Chrome.
  const install = (browser?: { id: string; name: string }) => {
    invoke("open_web_guard_store", { browser: browser?.id ?? null })
      .then(onClose)
      .catch((err) =>
        reportWriteFailure(`Couldn't open ${browser?.name ?? "Chrome"}. Install Web Guard from ${storeUrl}`, err)
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
          {!canLockDown ? "Lock-In can't check your browsers" : webGuardQuiet ? "Web Guard isn't answering" : "Other browsers are open"}
        </h2>
        <p className="text-sm font-bold text-ink/70 mb-3">
          {!canLockDown
            ? "Its browser check couldn't start, so this session can't block websites. It can still close your blocked apps."
            : webGuardQuiet
              ? "This session blocks websites, and Web Guard is what blocks them. Without it, Lock-In closes your browsers during the session."
              : `This session blocks websites, but Lock-In can't block them in ${list(closable)}.`}
        </p>
        {canLockDown && (
          <p className="text-xs font-bold text-ink/70 mb-3">
            Closing other browsers: {closable.length > 0 ? `${list(closable)} and any` : "any"} browser
            without Web Guard signed in to this account close{closable.length > 0 ? "" : "s"} after a 10 second warning, and again if
            reopened. Unsaved typing in them is lost.
          </p>
        )}
        {canLockDown && wrongAccount.length > 0 && (
          <p className="mb-3 rounded-lg border-1 border-ink/30 p-3 text-xs font-bold text-ink">
            {list(wrongAccount)}: Web Guard is installed but signed in to a different account or signed out — sign in
            with this account to keep {wrongAccount.length > 1 ? "these browsers" : "this browser"} open.
          </p>
        )}
        {canLockDown && installable.length > 0 && (
          <div className="mb-3 rounded-lg border-1 border-ink/30 p-3">
            <p className="text-xs font-bold text-ink mb-2">
              Install Web Guard in this browser to keep using it during sessions.
            </p>
            <p className="text-[10px] font-bold text-ink/60 mb-2">
              It has to be signed in to this Lock-In account.
            </p>
            <div className="flex flex-wrap gap-2 mb-2">
              {installable.map((b) => (
                <button
                  key={b.id}
                  onClick={() => install(b)}
                  className="bg-surface border-1 border-ink text-ink px-3 py-2 rounded-lg font-black text-[10px] label-action-sm"
                >
                  Install in {b.name}
                </button>
              ))}
            </div>
            <p className="text-[10px] font-bold text-ink/60 break-all select-text">{storeUrl}</p>
          </div>
        )}
        {incognitoGaps.length > 0 && (
          <p className="text-xs font-bold text-ink/70 mb-3">
            Web Guard isn't allowed in Incognito in {list(incognitoGaps)}, so it closes during the session too. To keep it open, turn on "Allow in Incognito" for Lock-In Web Guard in its extension settings.
          </p>
        )}
        <div className="flex flex-col gap-2 mt-2">
          {canLockDown && (
            <button onClick={onStartLockdown} className={primary}>
              Start and close other browsers
            </button>
          )}
          {webGuardQuiet && canLockDown && installable.length === 0 && (
            <button onClick={() => install()} className={secondary}>
              Install Web Guard
            </button>
          )}
          <button onClick={onStartAppsOnly} className={canLockDown ? secondary : primary}>
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
