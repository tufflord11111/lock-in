import { useEffect, useRef, useState } from "react";
import { Bird } from "lucide-react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { useCompanionSettingsView, writeCompanionSettings } from "../hooks/useCompanion";
import { DEFAULT_BRANCH_AT, loadBranchAt, saveBranchAt } from "../parrot/perch";

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

const fieldClass = "bg-transparent border-1 border-ink rounded-lg px-2 py-1 text-xs font-bold text-ink";

type BranchRange = { min: number; max: number; at: number };

/**
 * The branch's height on the right edge, as the perch point's fraction of the work
 * area's height. The overlay knows the work area and the branch drawing, so it says the
 * range; moving shows the branch there (solid, click-through), letting go saves it on
 * this PC, and the overlay hides it again 2 s later unless the bird is using it.
 */
function BranchHeight() {
  const saved = (() => {
    try {
      return loadBranchAt(window.localStorage);
    } catch {
      return undefined;
    }
  })();
  // Until the overlay answers: the whole screen, the overlay clamps.
  const [range, setRange] = useState<BranchRange>({ min: 0.05, max: 0.95, at: saved ?? DEFAULT_BRANCH_AT });
  const moving = useRef(false);
  useEffect(() => {
    const off = listen<BranchRange>("parrot:branch-range", (e) => {
      if (!moving.current) setRange(e.payload);
    });
    void emitTo("parrot", "parrot:branch-range?").catch(() => {});
    return () => void off.then((f) => f()).catch(() => {});
  }, []);
  const at = Math.min(range.max, Math.max(range.min, range.at));
  const preview = (value: number) => {
    moving.current = true;
    setRange((r) => ({ ...r, at: value }));
    void emitTo("parrot", "parrot:branch-preview", { at: value }).catch(() => {});
  };
  const commit = () => {
    if (!moving.current) return;
    moving.current = false;
    void emitTo("parrot", "parrot:branch-set", { at }).catch(() => {});
    // The overlay clamps and saves; this shows the value it kept.
    void emitTo("parrot", "parrot:branch-range?").catch(() => {});
  };
  const reset = () => {
    resetBranchPosition();
    setRange((r) => ({ ...r, at: DEFAULT_BRANCH_AT }));
    void emitTo("parrot", "parrot:branch-range?").catch(() => {});
  };
  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center justify-between gap-4 text-sm font-black text-ink label-plain tracking-tight">
        Branch height
        <span className="flex items-center gap-2">
          <input
            type="range"
            aria-label="Branch height"
            min={range.min}
            max={range.max}
            step={0.005}
            value={at}
            onChange={(e) => preview(Number(e.target.value))}
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={commit}
            className="w-40 accent-[var(--ink-2)] cursor-pointer"
          />
          <span className="text-xs tabular-nums w-9 text-right">{Math.round(at * 100)}%</span>
        </span>
      </label>
      <div className="flex items-center justify-between gap-4">
        <p className="text-[9px] font-bold text-ink/40">How far down the right edge the branch sits. It shows there while you move this.</p>
        <button type="button" className={fieldClass + " cursor-pointer whitespace-nowrap"} onClick={reset}>
          Reset branch position
        </button>
      </div>
    </div>
  );
}

const INTERVALS = [30, 45, 60, 90, 120, 240];

/** The parrot's on/off, how often it may speak, and its quiet hours. */
export function CompanionSettings({ userId }: { userId: string }) {
  const settings = useCompanionSettingsView(userId);

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
          <BranchHeight />
        </div>
      )}
    </section>
  );
}
