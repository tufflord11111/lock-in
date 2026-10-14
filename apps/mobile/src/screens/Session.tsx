import { useSession } from "../hooks/useSession";

type Props = { uid: string };

const mmss = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

const hhmm = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * Read-only view of the running session. The phone cannot start, end or bail
 * out of a session — the desktop owns all three (see useSession).
 */
export function Session({ uid }: Props) {
  const { session, isActive, expired, endTime, remainingSec, blockedApps, deviceId } = useSession(uid);

  const startedHere = session?.originDeviceId === deviceId;

  return (
    <div className="screen">
      <p className="eyebrow">Session</p>

      {isActive ? (
        <div className={`card ${expired ? "" : "danger"}`}>
          {expired ? (
            <span className="status">Session ended</span>
          ) : (
            <>
              <span className="status live">● Session active</span>
              <div className="countdown">{mmss(remainingSec)}</div>
            </>
          )}
          <div>
            <strong>{session?.objective || "Untitled Session"}</strong>
            <div className="muted">
              {startedHere ? "started on this phone" : "started on another device"}
            </div>
          </div>
          {!expired && (
            <>
              <p style={{ margin: 0, fontWeight: 800 }}>
                Ends at {endTime !== null ? hhmm(endTime) : "—"}. Bail out is on your laptop.
              </p>
              <p className="muted" style={{ margin: 0 }}>
                Your desktop enforcer and browser extension are following this session live.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="card">
          <span className="status">Idle</span>
          <p style={{ margin: 0, fontWeight: 800 }}>
            Sessions start on your laptop. This page shows them live.
          </p>
        </div>
      )}

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
