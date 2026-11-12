import { useEffect, useMemo, useState } from "react";
import { db } from "@lock-in/firebase";
import { onValue, ref } from "firebase/database";

/** "https://www.YouTube.com/x" → "youtube.com". null when it isn't a site. */
export function sanitizeSite(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/^www\./, "");
  if (!host.includes(".") || host.endsWith(".exe") || /[^a-z0-9.-]/.test(host)) return null;
  return host;
}

function values(node: unknown): unknown[] {
  if (Array.isArray(node)) return node;
  return node && typeof node === "object" ? Object.values(node) : [];
}

/**
 * The sites a session started now blocks, exactly as Web Guard applies them
 * (apps/extension/background.js): the session's default list less the defaults
 * the operator removed, plus custom blocks, plus permanent blocks. A removed
 * default only takes the default away: re-adding it as a custom block keeps it
 * (1.2.10 dropped it, so a list like that counted as blocking nothing and the
 * session ran without lockdown). Permanent blocks are blocked in the session too.
 */
export function sessionSitesFrom(sessionList: unknown[], custom: unknown[], removed: unknown[], permanent: unknown[]): string[] {
  const gone = new Set(removed.map(sanitizeSite));
  const defaults = sessionList.map(sanitizeSite).filter((s) => s !== null && !gone.has(s));
  const sites = [...defaults, ...custom.map(sanitizeSite), ...permanent.map(sanitizeSite)];
  return [...new Set(sites)].filter((s): s is string => s !== null);
}

/** The sites a session started now would block. Empty means the session blocks no sites. */
export function useSessionSites(userId: string | undefined, sessionList: string[]): string[] {
  const [custom, setCustom] = useState<unknown[]>([]);
  const [removed, setRemoved] = useState<unknown[]>([]);
  const [permanent, setPermanent] = useState<unknown[]>([]);

  useEffect(() => {
    setCustom([]);
    setRemoved([]);
    setPermanent([]);
    if (!userId) return;
    const offCustom = onValue(ref(db, `users/${userId}/customBlocks`), (s) => setCustom(values(s.val())));
    const offRemoved = onValue(ref(db, `users/${userId}/removedDefaults`), (s) => setRemoved(values(s.val())));
    const offPermanent = onValue(ref(db, `users/${userId}/permanentBlocks`), (s) => setPermanent(values(s.val())));
    return () => {
      offCustom();
      offRemoved();
      offPermanent();
    };
  }, [userId]);

  const key = sessionList.join("|");
  return useMemo(
    () => sessionSitesFrom(sessionList, custom, removed, permanent),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, custom, removed, permanent],
  );
}
