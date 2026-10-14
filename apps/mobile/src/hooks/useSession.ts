import { useEffect, useMemo, useState } from "react";
import { db } from "@lock-in/firebase";
import { ref, onValue } from "firebase/database";
import { getDeviceId } from "../deviceId";

/** Exactly the node shape the desktop writes and its cross-device mirror reads. */
export type SessionState = {
  isActive?: boolean;
  endTime?: number;
  objective?: string;
  blockedUrls?: string[];
  originDeviceId?: string;
} | null;

/**
 * The ONE source of truth is Firebase `users/{uid}/sessionState`.
 *
 * The phone is READ-ONLY for sessions. It writes nothing to sessionState,
 * config/focusActive, sessionHistory or history. The desktop owns start, Bail
 * out and completion: any phone write of `isActive: false` reached the
 * desktop's cross-device mirror as a remote stop and stood the Rust enforcer
 * down at once, bypassing Bail out's fuse. So this hook only listens.
 *
 * The countdown is derived from the absolute `endTime`, never from local
 * state, so it survives reload and agrees with every other surface. Past
 * endTime the session shows as ended; the desktop records the completion.
 */
export function useSession(uid: string) {
  const [session, setSession] = useState<SessionState>(null);
  const [blockedApps, setBlockedApps] = useState<string[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const deviceId = useMemo(getDeviceId, []);

  useEffect(() => {
    const u1 = onValue(
      ref(db, `users/${uid}/sessionState`),
      (snap) => setSession(snap.val() ?? null),
      (err) => console.error("[LOCK-IN mobile] sessionState listener error:", err)
    );
    const u2 = onValue(
      ref(db, `users/${uid}/blockedApps`),
      (snap) => {
        const data = snap.val();
        setBlockedApps(
          data ? (Object.values(data) as unknown[]).filter((v): v is string => typeof v === "string") : []
        );
      },
      (err) => console.error("[LOCK-IN mobile] blockedApps listener error:", err)
    );
    return () => {
      u1();
      u2();
    };
  }, [uid]);

  // Wall-clock tick. 250 ms keeps mm:ss honest without burning the battery.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  const isActive = session?.isActive === true;
  const endTime = typeof session?.endTime === "number" ? session.endTime : null;
  const remainingSec =
    isActive && endTime !== null ? Math.max(0, Math.ceil((endTime - now) / 1000)) : 0;

  // Display only: past its deadline the session reads as ended here. Nothing
  // is written — the desktop's own deadline ends and records it.
  const expired = isActive && endTime !== null && now >= endTime;

  return { session, isActive, expired, endTime, remainingSec, blockedApps, deviceId };
}
