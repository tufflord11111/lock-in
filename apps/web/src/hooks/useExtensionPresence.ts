import { useCallback, useEffect, useRef, useState } from "react";
import { db } from "@lock-in/firebase";
import { onValue, ref } from "firebase/database";

/** The extension beats every 30 s, so 60 s tolerates one missed beat. */
const STALE_AFTER_MS = 60_000;
const RECHECK_MS = 10_000;

/**
 * Whether the Chrome extension has gone quiet.
 *
 * The check has to read the clock on a timer. A snapshot only arrives when
 * last_seen changes, and when the extension stops writing, it stops changing:
 * checked only on snapshots, this could never turn stale. A throttled timer
 * only delays the answer, because the value it reads is the clock.
 *
 * Nothing heard yet is not stale. Only a value from Firebase can say the
 * extension is missing.
 */
export function useExtensionPresence(userId: string | undefined) {
  // undefined: nothing heard yet. null: Firebase says it has never been seen.
  const lastSeenRef = useRef<number | null | undefined>(undefined);
  const [stale, setStale] = useState(false);

  const isStaleNow = useCallback(() => {
    const lastSeen = lastSeenRef.current;
    if (lastSeen === undefined) return false;
    return lastSeen === null || Date.now() - lastSeen > STALE_AFTER_MS;
  }, []);

  useEffect(() => {
    lastSeenRef.current = undefined;
    setStale(false);
    if (!userId) return;
    const unsub = onValue(ref(db, `users/${userId}/extension_state/last_seen`), (snap) => {
      const value = snap.val();
      lastSeenRef.current = typeof value === "number" ? value : null;
      setStale(isStaleNow());
    });
    const timer = setInterval(() => setStale(isStaleNow()), RECHECK_MS);
    return () => {
      unsub();
      clearInterval(timer);
    };
  }, [userId, isStaleNow]);

  return { stale, isStaleNow };
}
