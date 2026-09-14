import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { db } from "@lock-in/firebase";
import { ref, onValue, update, push, increment, serverTimestamp } from "firebase/database";
import { getDeviceId } from "../deviceId";
import { WEB_BLOCKLIST } from "../constants";
import { guardWrite } from "../writeFailures";

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
 * Mobile has no Tauri and no enforcer. Starting a session here writes the same
 * shape the desktop's startSession writes, stamped with THIS device's id. The
 * desktop's sessionState listener sees a non-echo `isActive: true` transition
 * and arms its Rust enforcer via update_enforcement(fromRemote: true); the
 * extension reads `config/focusActive` and `sessionState.blockedUrls`. Ending
 * writes `isActive: false` the same way and both stand down.
 *
 * The countdown is derived from the absolute `endTime`, never from local
 * state, so it survives reload and agrees with every other surface.
 */
export function useSession(uid: string) {
  const [session, setSession] = useState<SessionState>(null);
  const [blockedApps, setBlockedApps] = useState<string[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const deviceId = useMemo(getDeviceId, []);
  const endingRef = useRef(false);
  /** Set only when THIS phone started the session; used for the minutes log. */
  const startedAtRef = useRef<number | null>(null);

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

  const startSession = useCallback(
    async (minutes: number, objective: string) => {
      const end = Date.now() + minutes * 60_000;
      startedAtRef.current = Date.now();
      // Same shape, same field order, as apps/web startSession's masterBlockList:
      // the eight web defaults followed by the user's exe names.
      const blockedUrls = [...WEB_BLOCKLIST, ...blockedApps];
      await update(ref(db), {
        [`users/${uid}/sessionState`]: {
          isActive: true,
          endTime: end,
          objective: objective.trim() || "Untitled Session",
          blockedUrls,
          originDeviceId: deviceId,
        },
        [`users/${uid}/config/focusActive`]: true,
      });
    },
    [uid, deviceId, blockedApps]
  );

  const endSession = useCallback(
    async (completed: boolean) => {
      if (endingRef.current) return;
      endingRef.current = true;
      try {
        const objective = session?.objective ?? "Untitled Session";
        const minutes =
          startedAtRef.current !== null
            ? Math.max(0, Math.ceil((Date.now() - startedAtRef.current) / 60_000))
            : 0;
        startedAtRef.current = null;

        // Atomic: both flags flip together, exactly as the desktop's endSession.
        await update(ref(db), {
          [`users/${uid}/sessionState`]: { isActive: false, originDeviceId: deviceId },
          [`users/${uid}/config/focusActive`]: false,
        });

        // History is fire-and-forget, matching the desktop — but a failure is
        // now surfaced instead of being discarded by a bare catch.
        guardWrite(
          push(ref(db, `users/${uid}/sessionHistory`), {
            objective,
            minutes,
            timestamp: serverTimestamp(),
            status: completed ? "completed" : "aborted",
          }),
          "Your session wasn't added to your history. Check your connection."
        );
        if (minutes > 0) {
          const today = new Date().toLocaleDateString("en-CA");
          guardWrite(
            update(ref(db, `users/${uid}/history`), { [today]: increment(minutes) }),
            "Your session minutes didn't save, so your streak won't count this session. Check your connection."
          );
        }
      } finally {
        endingRef.current = false;
      }
    },
    [uid, deviceId, session?.objective]
  );

  // Deadline passed while this screen is open: complete it, as the desktop's
  // timer does when it hits zero. The desktop enforcer expires itself on its
  // own clock regardless; this just brings Firebase into agreement.
  const expired = isActive && endTime !== null && now >= endTime;
  useEffect(() => {
    if (expired) endSession(true);
  }, [expired, endSession]);

  return { session, isActive, endTime, remainingSec, blockedApps, deviceId, startSession, endSession };
}
