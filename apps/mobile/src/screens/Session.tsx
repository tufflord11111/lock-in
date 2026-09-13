import { useState } from "react";
import { useSession } from "../hooks/useSession";
import { DURATIONS } from "../constants";

type Props = { uid: string };

const mmss = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export function Session({ uid }: Props) {
  const { session, isActive, endTime, remainingSec, blockedApps, deviceId, startSession, endSession } =
    useSession(uid);
  const [minutes, setMinutes] = useState(25);
  const [objective, setObjective] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(String((err as { message?: string })?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  const startedHere = session?.originDeviceId === deviceId;

  return (
    <div className="screen">
      <p className="eyebrow">Session control</p>

      {isActive ? (
        <div className="card danger">
          <span className="status live">● Session active</span>
          <div className="countdown">{mmss(remainingSec)}</div>
          <div>
            <strong>{session?.objective || "Untitled Session"}</strong>
            <div className="muted">
              Ends {endTime ? new Date(endTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}
              {" · "}
              {startedHere ? "started on this phone" : "started on another device"}
            </div>
          </div>
          <button className="btn red" disabled={busy} onClick={() => run(() => endSession(false))}>
            {busy ? "Ending…" : "End session"}
          </button>
          <p className="muted" style={{ margin: 0 }}>
            Your desktop enforcer and browser extension are following this session live.
          </p>
        </div>
      ) : (
        <div className="card">
          <span className="status">Idle</span>
          <div className="chips">
            {DURATIONS.map((d) => (
              <button
                key={d.minutes}
                type="button"
                className={`chip ${minutes === d.minutes ? "on" : ""}`}
                onClick={() => setMinutes(d.minutes)}
              >
                {d.minutes}
                <small>{d.label}</small>
              </button>
            ))}
          </div>
          <label>
            Objective (optional)
            <input
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder="e.g. Ship the demo"
              maxLength={60}
            />
          </label>
          <button
            className="btn"
            disabled={busy}
            onClick={() => run(() => startSession(minutes, objective))}
          >
            {busy ? "Starting…" : `Start ${minutes} min session`}
          </button>
          <p className="muted" style={{ margin: 0 }}>
            Starting here arms the desktop enforcer remotely. Blocked apps will be closed
            immediately, without saving, for the whole session.
          </p>
        </div>
      )}

      {error && <div className="error">⚠ {error}</div>}

      <div className="card">
        <p className="eyebrow">Blocked apps ({blockedApps.length})</p>
        {blockedApps.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            None configured. Add apps from the desktop — this list is read-only here.
          </p>
        ) : (
          <ul className="list">
            {blockedApps.map((exe) => (
              <li key={exe}>
                <span>{exe}</span>
                <span className="muted">KILL</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
