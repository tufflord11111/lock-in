import { useCallback, useEffect, useState } from "react";
import { db } from "@lock-in/firebase";
import { ref, child, get } from "firebase/database";

type Row = { rank: number; name: string; hours: number };

/**
 * Read-only leaderboard from `leaderboard/all_time`. The parser is a copy of
 * the desktop's (ThePack.tsx): the node is populated outside this repo and the
 * value shape is either `{username: hoursNumber}` or
 * `{key: {username, uptimeToday, currentStreak}}`, so both are accepted.
 */
export function Pack() {
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const snap = await get(child(ref(db), "leaderboard/all_time"));
      if (!snap.exists()) {
        setRows([]);
        return;
      }
      const data = snap.val() as Record<string, unknown>;
      const raw = Object.entries(data).map(([key, value]) =>
        typeof value === "number"
          ? { username: key, uptimeToday: value * 60 }
          : (value as { username?: string; uptimeToday?: unknown })
      );
      const sorted = raw
        .map((u) => ({ name: u.username || "Unknown Operator", minutes: Number(u.uptimeToday) || 0 }))
        .sort((a, b) => b.minutes - a.minutes)
        .map((u, i) => ({ rank: i + 1, name: u.name, hours: Number((u.minutes / 60).toFixed(1)) }));
      setRows(sorted);
    } catch (err) {
      setError(String((err as { message?: string })?.message ?? err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="screen">
      <p className="eyebrow">The Pack // Leaderboard</p>
      <div className="card">
        <button className="btn ghost small" disabled={busy} onClick={load}>
          {busy ? "Syncing…" : "Refresh ranks"}
        </button>
        {error && <div className="error">⚠ {error}</div>}
        {rows.length === 0 && !busy && !error ? (
          <p className="muted" style={{ margin: 0 }}>No records found.</p>
        ) : (
          <ul className="list">
            {rows.map((r) => (
              <li key={`${r.rank}-${r.name}`}>
                <span>
                  <span className="rank">#{r.rank}</span>
                  {r.name}
                </span>
                <span className="hours">{r.hours}h</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
