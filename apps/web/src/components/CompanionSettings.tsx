import { Bird } from "lucide-react";
import { emitTo } from "@tauri-apps/api/event";
import { useCompanionSettingsView, writeCompanionSettings } from "../hooks/useCompanion";
import { saveBranchAt } from "../parrot/perch";

/**
 * Back to the default height on the right edge. The height is kept on this PC only
 * (localStorage, shared with the overlay), so this forgets it here and tells the overlay.
 */
export function resetBranchPosition() {
  try {
    saveBranchAt(window.localStorage, undefined);
  } catch {
    // No storage: the overlay still hears the reset.
  }
  void emitTo("parrot", "parrot:branch-reset").catch(() => {});
}

const INTERVALS = [30, 45, 60, 90, 120, 240];

/** The parrot's on/off, how often it may speak, and its quiet hours. */
export function CompanionSettings({ userId }: { userId: string }) {
  const settings = useCompanionSettingsView(userId);
  const fieldClass = "bg-transparent border-1 border-ink rounded-lg px-2 py-1 text-xs font-bold text-ink";

  return (
    <section className="bg-surface border-1 border-ink p-6 rounded-2xl shadow-[shadow:var(--shadow-2)]">
      <div className="flex items-center gap-3 mb-4">
        <Bird size={18} className="text-ink" />
        <h2 className="text-[10px] font-black label-plain tracking-[0.2em] text-ink/30">Parrot companion</h2>
      </div>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-black text-ink label-plain tracking-tight">Show the parrot</p>
          <p className="text-[9px] font-bold text-ink/40 mt-1">
            It walks along the bottom of your screen, naps during sessions and sometimes suggests one
          </p>
        </div>
        <button
          onClick={() => void writeCompanionSettings(userId, { enabled: !settings.enabled })}
          role="switch"
          aria-checked={settings.enabled}
          aria-label="Show the parrot"
          style={{
            position: "relative",
            display: "inline-flex",
            alignItems: "center",
            width: "48px",
            height: "26px",
            borderRadius: "999px",
            border: "2px solid var(--ink-2)",
            background: settings.enabled ? "var(--highlight-2)" : "transparent",
            cursor: "pointer",
            transition: "background 0.2s",
            flexShrink: 0,
            padding: 0,
            outline: "none",
          }}
        >
          <span
            style={{
              position: "absolute",
              top: "2px",
              left: settings.enabled ? "24px" : "2px",
              width: "18px",
              height: "18px",
              borderRadius: "50%",
              background: "var(--ink-2)",
              transition: "left 0.2s",
            }}
          />
        </button>
      </div>
      {settings.enabled && (
        <div className="mt-5 flex flex-col gap-3">
          <label className="flex items-center justify-between gap-4 text-sm font-black text-ink label-plain tracking-tight">
            At most one suggestion every
            <select
              className={fieldClass}
              value={settings.nudgeAfterMin}
              onChange={(e) => void writeCompanionSettings(userId, { nudgeAfterMin: Number(e.target.value) })}
            >
              {INTERVALS.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes} min
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center justify-between gap-4 text-sm font-black text-ink label-plain tracking-tight">
            Quiet hours
            <span className="flex items-center gap-2">
              <input
                type="time"
                aria-label="Quiet hours start"
                className={fieldClass}
                value={settings.quietStart}
                onChange={(e) => {
                  if (e.target.value) void writeCompanionSettings(userId, { quietStart: e.target.value });
                }}
              />
              <span className="text-xs">to</span>
              <input
                type="time"
                aria-label="Quiet hours end"
                className={fieldClass}
                value={settings.quietEnd}
                onChange={(e) => {
                  if (e.target.value) void writeCompanionSettings(userId, { quietEnd: e.target.value });
                }}
              />
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-black text-ink label-plain tracking-tight">Branch position</p>
              <p className="text-[9px] font-bold text-ink/40 mt-1">Hold Ctrl and drag the branch up or down the right edge to move it</p>
            </div>
            <button type="button" className={fieldClass + " cursor-pointer whitespace-nowrap"} onClick={resetBranchPosition}>
              Reset branch position
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
