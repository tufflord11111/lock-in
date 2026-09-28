import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { db } from "@lock-in/firebase";
import { ref, get, update } from "firebase/database";
import type { EnforcerState } from "./EnforcerDisarmPanel";
import { reportWriteFailure } from "../writeFailures";

/**
 * Local approval gate for blocks that arrive from a remote (Firebase) sync.
 *
 * Anyone with the account can add to the victim's blockedApps (session kills)
 * or permanentExe (24/7 kills) from another device. Rust stages any such NEW
 * entry as *pending* and does NOT enforce it until it is approved here, on
 * this machine (F4 for permanent, G1 for session apps). Rejecting also deletes
 * the entries from Firebase so they cannot re-stage on the next sync.
 */
export function PendingPermanentBanner({ userId }: { userId: string }) {
  const [exePending, setExePending] = useState<string[]>([]);
  const [permPending, setPermPending] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    invoke<EnforcerState>("get_enforcer_state")
      .then((s) => {
        setExePending(s.exe_pending ?? []);
        setPermPending(s.permanent_pending ?? []);
      })
      .catch(() => {
        /* not under Tauri — no enforcer, nothing pending */
      });
  }, []);

  useEffect(() => {
    refresh();
    const a = listen("permanent-pending", () => refresh());
    const b = listen("exe-pending", () => refresh());
    return () => {
      a.then((f) => f());
      b.then((f) => f());
    };
  }, [refresh]);

  const total = exePending.length + permPending.length;
  if (total === 0) return null;

  const approve = async () => {
    setBusy(true);
    try {
      if (exePending.length) await invoke("confirm_pending_exe");
      if (permPending.length) await invoke("confirm_pending_permanent");
    } catch (err) {
      // try/finally alone let this reject uncaught, with nothing on screen.
      reportWriteFailure(
        "Couldn't approve the new blocks, so they still aren't enforced. Try again, or restart Lock-In.",
        err
      );
    } finally {
      setBusy(false);
      refresh();
    }
  };

  // Delete rejected entries from a Firebase node, matching the same cleaning
  // Rust applies to values, then tell Rust to drop the pending set.
  const cleanNode = async (node: string, rejected: Set<string>) => {
    if (rejected.size === 0) return;
    const snap = await get(ref(db, `users/${userId}/${node}`));
    const obj = (snap.val() as Record<string, unknown>) || {};
    const updates: Record<string, null> = {};
    for (const [key, value] of Object.entries(obj)) {
      const cleaned = String(value)
        .toLowerCase()
        .replace(/\.exe/g, "")
        .replace(/[^a-z0-9._-]/g, "");
      if (rejected.has(cleaned)) updates[key] = null;
    }
    if (Object.keys(updates).length > 0) {
      await update(ref(db, `users/${userId}/${node}`), updates);
    }
  };

  const reject = async () => {
    setBusy(true);
    try {
      await cleanNode("blockedApps", new Set(exePending));
      await cleanNode("permanentExe", new Set(permPending));
      if (exePending.length) await invoke("reject_pending_exe");
      if (permPending.length) await invoke("reject_pending_permanent");
    } catch (err) {
      // The banner re-reads Rust below, so whatever wasn't rejected stays
      // listed for another try; they are still not enforced either way.
      reportWriteFailure(
        "Couldn't reject all of the new blocks. They still aren't enforced, and the banner shows what's left — try again.",
        err
      );
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const parts: string[] = [];
  if (exePending.length) parts.push(`apps: ${exePending.join(", ")}`);
  if (permPending.length) parts.push(`permanent: ${permPending.join(", ")}`);

  return (
    <div className="w-full bg-danger text-surface-inverse px-6 py-4 z-30 shrink-0 font-mono">
      <div className="max-w-[1600px] mx-auto flex items-center justify-between gap-6 flex-wrap">
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-[11px] font-black label-sm">
            New block{total > 1 ? "s" : ""} awaiting your approval
          </span>
          <span className="text-[10px] font-bold text-surface-inverse/80 break-words">
            These were added from another device and will close matching apps —
            until you approve them here they do nothing. {parts.join(" · ")}
          </span>
        </div>
        <div className="flex gap-3 shrink-0">
          <button
            onClick={reject}
            disabled={busy}
            className="px-5 py-2 bg-surface-inverse/10 border-1 border-surface-inverse/40 text-surface-inverse font-black text-[10px] label-action-sm hover:bg-surface-inverse/20 transition-colors disabled:opacity-50"
          >
            Reject
          </button>
          <button
            onClick={approve}
            disabled={busy}
            className="px-5 py-2 bg-surface text-danger font-black text-[10px] label-action-sm hover:bg-surface-inverse/90 transition-colors disabled:opacity-50"
          >
            {busy ? "Working…" : "Approve"}
          </button>
        </div>
      </div>
    </div>
  );
}
