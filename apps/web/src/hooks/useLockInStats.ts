import { useEffect, useMemo, useState } from "react";
import { ref, onValue } from "firebase/database";
import { db } from "@lock-in/firebase";
import { DEFAULT_WEB_BLOCKS } from "../screens/BlockRegistry";

export type LockInStats = {
  /** Consecutive days, counting back from today, with any logged minutes. */
  streak: number;
  /** Blocked executables. */
  apps: number;
  /** Blocked domains: the defaults that are still in place, plus custom ones. */
  sites: number;
};

/**
 * The three numbers the Botanical stat strip and the Bento session card show.
 * Read-only; it never writes, so it is safe to mount more than once.
 */
export function useLockInStats(userId: string | undefined): LockInStats {
  const [history, setHistory] = useState<Record<string, number>>({});
  const [apps, setApps] = useState(0);
  const [custom, setCustom] = useState(0);
  const [removed, setRemoved] = useState<string[]>([]);

  useEffect(() => {
    if (!userId) return;
    const subs = [
      onValue(ref(db, `users/${userId}/history`), (s) => setHistory(s.val() || {})),
      onValue(ref(db, `users/${userId}/blockedApps`), (s) => setApps(Object.keys(s.val() || {}).length)),
      onValue(ref(db, `users/${userId}/customBlocks`), (s) => setCustom(Object.keys(s.val() || {}).length)),
      onValue(ref(db, `users/${userId}/removedDefaults`), (s) => setRemoved(s.val() || [])),
    ];
    return () => subs.forEach((u) => u());
  }, [userId]);

  const streak = useMemo(() => {
    let n = 0;
    const today = new Date().toLocaleDateString("en-CA");
    const cursor = new Date();
    if ((history[today] || 0) === 0) cursor.setDate(cursor.getDate() - 1);
    while ((history[cursor.toLocaleDateString("en-CA")] || 0) > 0) {
      n++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return n;
  }, [history]);

  const sites = DEFAULT_WEB_BLOCKS.filter((d) => !removed.includes(d)).length + custom;
  return { streak, apps, sites };
}
