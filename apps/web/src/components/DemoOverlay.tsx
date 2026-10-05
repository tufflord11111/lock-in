import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

type KillEvent = { name: string; timestamp: number };

/**
 * A corner panel showing the enforcer's kills as they happen, large enough to
 * read from the back of a room. Toggled with Ctrl+Shift+D and only when
 * DEV_MODE is present, so a normal install has no way to summon it.
 *
 * It listens to the same "process-killed" event KillFeed does — Rust emits it
 * from the sniper thread, with no network involved, so it works in a blackout.
 */
export function DemoOverlay({ enabled }: { enabled: boolean }) {
  const [visible, setVisible] = useState(false);
  const [kills, setKills] = useState<KillEvent[]>([]);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "D" || e.key === "d")) {
        e.preventDefault();
        setVisible((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !visible) return;
    let stop: (() => void) | undefined;
    listen<KillEvent>("process-killed", (event) => {
      setKills((prev) => [event.payload, ...prev].slice(0, 8));
    })
      .then((un) => {
        stop = un;
      })
      .catch(() => {
        /* no Tauri, no kills to show */
      });
    return () => stop?.();
  }, [enabled, visible]);

  if (!enabled || !visible) return null;

  return (
    <div className="fixed bottom-8 right-8 z-[130] w-[420px] pointer-events-none">
      <div className="bg-hero text-surface-inverse rounded-2xl shadow-[shadow:var(--shadow-5)] p-6 flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className="w-3 h-3 rounded-full bg-danger animate-pulse" />
          <span className="text-sm font-black label-action-sm">ENFORCER — LIVE</span>
        </div>

        {kills.length === 0 ? (
          <p className="text-2xl font-bold opacity-50 leading-snug">Waiting for a distraction…</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {kills.map((k, i) => (
              <li
                key={`${k.timestamp}-${k.name}-${i}`}
                className="flex items-baseline justify-between gap-4"
                style={{ opacity: 1 - i * 0.11 }}
              >
                <span className="text-3xl font-black tracking-tight truncate">{k.name}</span>
                <span className="text-sm font-bold tabular-nums opacity-60 shrink-0">
                  {new Date(k.timestamp * 1000).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
