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
 * The sites a session started now would block: the same union the extension
 * applies (the session's list, plus custom blocks, minus removed defaults).
 * Empty means the session needs no extension.
 */
export function useSessionSites(userId: string | undefined, sessionList: string[]): string[] {
  const [custom, setCustom] = useState<unknown[]>([]);
  const [removed, setRemoved] = useState<unknown[]>([]);

  useEffect(() => {
    setCustom([]);
    setRemoved([]);
    if (!userId) return;
    const offCustom = onValue(ref(db, `users/${userId}/customBlocks`), (s) => setCustom(values(s.val())));
    const offRemoved = onValue(ref(db, `users/${userId}/removedDefaults`), (s) => setRemoved(values(s.val())));
    return () => {
      offCustom();
      offRemoved();
    };
  }, [userId]);

  const key = sessionList.join("|");
  return useMemo(() => {
    const gone = new Set(removed.map(sanitizeSite));
    const sites = [...sessionList, ...custom].map(sanitizeSite);
    return [...new Set(sites)].filter((s): s is string => s !== null && !gone.has(s));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, custom, removed]);
}
