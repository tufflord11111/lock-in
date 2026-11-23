import { useEffect, useRef } from "react";
import { ref, onValue } from "firebase/database";
import { db } from "@lock-in/firebase";
import {
  bootSnapshot,
  emptySnapshot,
  trimHistory,
  trimSessions,
  writeSnapshot,
  type Snapshot,
} from "../snapshot";
import { SnapshotDraft } from "../snapshotGate";

/**
 * Keeps snapshot.json current while the app is online.
 *
 * One listener per node the dashboard needs, merged into a single snapshot and
 * written out debounced. These are the same paths the screens already listen
 * to, so being online costs one extra read each and nothing while offline —
 * where no listener fires at all and the snapshot simply stays as it was.
 *
 * Nothing is written until the server has answered for config and blockedApps
 * in this run, and never with a missing or empty config (snapshotGate.ts).
 * After an in-app sign-out and sign-in, the first answer used to put a
 * near-empty snapshot on disk.
 */
const DEBOUNCE_MS = 1500;

export function useSnapshotWriter(userId: string | undefined): void {
  const draft = useRef<SnapshotDraft | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!userId) return;

    // Only this account's boot snapshot may seed the draft.
    const boot = bootSnapshot();
    const previous = boot?.uid === userId ? boot : null;
    draft.current = new SnapshotDraft({ ...(previous ?? emptySnapshot(userId)), uid: userId });
    const writeIfReady = () => {
      if (draft.current?.writable()) writeSnapshot(draft.current.snapshot);
    };

    const flush = () => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(writeIfReady, DEBOUNCE_MS);
    };

    const patch = (path: string, fn: (s: Snapshot) => void) => {
      if (!draft.current) return;
      draft.current.apply(path, fn);
      flush();
    };

    const listen = (path: string, apply: (value: unknown, s: Snapshot) => void) =>
      onValue(
        ref(db, `users/${userId}/${path}`),
        (snap) => patch(path, (s) => apply(snap.val(), s)),
        () => {
          /* a refused or failed read leaves the previous snapshot in place */
        }
      );

    const subs = [
      listen("config", (v, s) => {
        s.config = (v ?? {}) as Record<string, unknown>;
        const handle = (s.config.userName ?? s.config.username) as unknown;
        if (typeof handle === "string") s.handle = handle;
      }),
      listen("public/userName", (v, s) => {
        if (typeof v === "string") s.handle = v;
      }),
      listen("blockedApps", (v, s) => {
        s.blockedAppsRaw = (v ?? {}) as Record<string, string>;
        s.blockedApps = Object.values(s.blockedAppsRaw).filter((x): x is string => typeof x === "string");
      }),
      listen("blockedApps_meta", (v, s) => {
        s.blockedAppsMeta = (v ?? {}) as Record<string, string>;
      }),
      listen("permanentExe", (v, s) => {
        s.permanentExe = Object.values((v ?? {}) as Record<string, string>).filter(
          (x): x is string => typeof x === "string"
        );
      }),
      listen("customBlocks", (v, s) => {
        s.customBlocks = (v ?? {}) as Record<string, string>;
      }),
      listen("permanentBlocks", (v, s) => {
        s.permanentBlocks = (v ?? {}) as Record<string, string>;
      }),
      listen("removedDefaults", (v, s) => {
        s.removedDefaults = Array.isArray(v) ? (v as string[]) : [];
      }),
      listen("friends", (v, s) => {
        s.friends = Object.entries((v ?? {}) as Record<string, unknown>).map(([uid, entry]) => ({
          uid,
          name:
            entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string"
              ? ((entry as { name: string }).name)
              : "",
        }));
      }),
      listen("history", (v, s) => {
        s.history = trimHistory((v ?? {}) as Record<string, number>);
      }),
      listen("sessionHistory", (v, s) => {
        s.sessionHistory = trimSessions((v ?? {}) as Record<string, unknown>);
      }),
    ];

    return () => {
      subs.forEach((u) => u());
      if (timer.current) window.clearTimeout(timer.current);
      // One last write on unmount, so quitting right after a change keeps it.
      writeIfReady();
      draft.current = null;
    };
  }, [userId]);
}
