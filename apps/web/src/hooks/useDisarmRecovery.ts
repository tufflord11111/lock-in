import { useEffect, useRef } from "react";
import { db } from "@lock-in/firebase";
import { ref, update, push, serverTimestamp } from "firebase/database";
import { invoke } from "@tauri-apps/api/core";

/** Mirrors the Rust EnforcerState struct (serde emits these names as declared). */
type EnforcerState = {
  is_locked: boolean;
  focus_active: boolean;
  exe_blacklist_len: number;
  permanent_exe_len: number;
  disarm_latch: boolean;
};

/**
 * Disarm recovery.
 *
 * The disarm latch lives in Rust memory, so it dies with the process. A trapped
 * operator's instinct is to quit and relaunch — which would drop the latch and
 * let the stale `config/focusActive: true` re-trap them on the next sync.
 *
 * This closes that hole at the source: on the first successful auth after a
 * disarm, clear the stale Firebase flags, log the disarm, and only then release
 * the latch.
 *
 * Must NOT live in DegradedScreen — that component unmounts the instant auth
 * succeeds, which is exactly when this needs to run.
 */
export function useDisarmRecovery(userId: string | undefined) {
  // In-flight guard ONLY — never a "done" flag. Rust's disarm_latch is the
  // idempotency source: a run that finds it false is a no-op, so EVERY userId
  // transition re-probes (one cheap IPC call) and only concurrent runs are
  // suppressed. The previous "once per boot" ref burned on the first auth of
  // the process; a Login-screen disarm followed by sign-in is a SECOND
  // transition in the same process, and recovery silently never ran.
  const inFlight = useRef(false);

  useEffect(() => {
    if (!userId || inFlight.current) return;
    inFlight.current = true; // set BEFORE the first await — no concurrent runs

    (async () => {
      try {
        let state: EnforcerState;
        try {
          state = await invoke<EnforcerState>("get_enforcer_state");
        } catch (err) {
          // Not running under Tauri, or IPC failed. Nothing to recover.
          console.warn("[LOCK-IN] disarm recovery: get_enforcer_state failed:", err);
          return;
        }

        if (!state.disarm_latch) {
          console.info("[LOCK-IN] disarm recovery: latch not set — nothing to do");
          return;
        }

        console.info("[LOCK-IN] disarm recovery: latch is SET — clearing stale session state");

        try {
          // (a) Clear the flags that would otherwise re-arm the enforcer, and the
          //     one the Chrome extension reads. update() (not set()) so sibling
          //     fields such as endTime/objective/blockedUrls survive.
          await update(ref(db, `users/${userId}/config`), { focusActive: false });
          console.info("[LOCK-IN] disarm recovery: cleared config/focusActive");

          await update(ref(db, `users/${userId}/sessionState`), { isActive: false });
          console.info("[LOCK-IN] disarm recovery: cleared sessionState/isActive");

          // (b) Record the disarm as an aborted session. minutes:0 so it cannot
          //     inflate the AVG SESSION stat, and users/{uid}/history is
          //     deliberately NOT written so the streak stays untouched.
          await push(ref(db, `users/${userId}/sessionHistory`), {
            objective: "EMERGENCY DISARM",
            minutes: 0,
            timestamp: serverTimestamp(),
            status: "aborted",
          });
          console.info("[LOCK-IN] disarm recovery: logged aborted session record");
        } catch (err) {
          // Leave the latch ARMED. While the stale flags are still out there the
          // enforcer must remain un-re-armable, so this is the safe failure.
          console.error(
            "[LOCK-IN] disarm recovery: Firebase write failed — latch left ARMED:",
            err,
          );
          return;
        }

        // (c) Stale state is gone — only now is it safe to release the latch.
        try {
          const res = await invoke<string>("clear_disarm_latch");
          console.info("[LOCK-IN] disarm recovery: latch cleared —", res);
        } catch (err) {
          console.error("[LOCK-IN] disarm recovery: clear_disarm_latch failed:", err);
        }
      } finally {
        inFlight.current = false;
      }
    })();
  }, [userId]);
}
