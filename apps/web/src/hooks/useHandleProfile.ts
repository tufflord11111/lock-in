import { useCallback, useEffect, useState } from "react";
import { db } from "@lock-in/firebase";
import { ref, onValue, update, serverTimestamp } from "firebase/database";
import { HANDLE_REGEX } from "./useFriends";
import { logUiEvent } from "../uiEventLog";
import { bootSnapshot } from "../snapshot";

/**
 * The operator's name and handle, read from the SAME place registration
 * writes them: users/{uid}/config/{userName, username, usernameSet}.
 *
 * App used to read top-level users/{uid}/username and usernameSet, which
 * registration never writes. So every normally registered account got the
 * "Choose Your Handle" overlay after onboarding, and its display name —
 * initialised to "Operator" and synced to the database on every launch — was
 * overwritten with "Operator". A handle picked in that overlay was written
 * top-level and never reserved in usernames/.
 *
 * The rule here: a handle is only ever written together with its
 * usernames/{handle} reservation, in one atomic update, so the rules either
 * accept both or neither. Nothing unreserved is written anywhere.
 */

export type HandleStatus =
  /** Still deciding (profile not loaded, or a migration in flight). */
  | "checking"
  /** Decided. usernameSet tells App whether to show the overlay. */
  | "ready";

export class HandleTakenError extends Error {
  code = "handle-taken" as const;
  constructor() {
    super("That handle is taken — pick another");
  }
}

export class HandleInvalidError extends Error {
  code = "handle-invalid" as const;
  constructor(message: string) {
    super(message);
  }
}

/**
 * One read that waits for the server, like onValue — unlike get(), which
 * rejects on an offline boot with nothing cached.
 */
function readOnce(path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    onValue(ref(db, path), (s) => resolve(s.val()), reject, { onlyOnce: true });
  });
}

function isPermissionDenied(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | undefined;
  return (
    e?.code === "PERMISSION_DENIED" ||
    /permission[_ ]denied/i.test(e?.message ?? "")
  );
}

/** Display form, exactly as registration shows it: the handle uppercased. */
export function displayFromHandle(handle: string): string {
  return handle.toUpperCase();
}

/**
 * The atomic write that claims a handle. The same five paths registration
 * writes for the profile's identity, plus clearing the legacy top-level
 * fields so the two can never disagree again.
 */
function reserveHandleUpdates(uid: string, handle: string): Record<string, unknown> {
  const display = displayFromHandle(handle);
  return {
    [`users/${uid}/config/username`]: handle,
    [`users/${uid}/config/usernameSet`]: true,
    [`users/${uid}/config/userName`]: display,
    [`users/${uid}/public/userName`]: display,
    [`usernames/${handle}`]: uid,
    [`users/${uid}/username`]: null,
    [`users/${uid}/usernameSet`]: null,
  };
}

/**
 * Validate a handle typed into the overlay the way registration does — letters,
 * numbers, underscore, at most 20 — and return its reservation key.
 */
export function normaliseHandle(raw: string): string {
  const handle = raw.trim().toLowerCase();
  if (!handle) throw new HandleInvalidError("Handle cannot be empty.");
  if (!HANDLE_REGEX.test(handle)) {
    throw new HandleInvalidError(
      handle.length > 20
        ? "Handle must be 20 characters or fewer."
        : "Only letters, numbers, and underscores allowed."
    );
  }
  return handle;
}

/**
 * Build the reservation write for a handle. Returned un-awaited so the caller
 * can race it (B5). A denial means the handle is owned by someone else; map
 * it with asHandleError.
 */
export function reserveHandle(uid: string, raw: string): Promise<void> {
  const handle = normaliseHandle(raw);
  return update(ref(db), reserveHandleUpdates(uid, handle));
}

/** Turn a reservation failure into the error the overlay should show. */
export function asHandleError(err: unknown): Error {
  return isPermissionDenied(err) ? new HandleTakenError() : (err as Error);
}

export function useHandleProfile(uid: string | undefined, emailVerified: boolean) {
  // null = not loaded from the database yet. Never written as a default.
  // The real handle, off disk, on frame one. Without this an offline boot
  // showed "Operator" until the listener fired — which offline is never.
  const [userName, setUserName] = useState<string | null>(() => bootSnapshot()?.handle ?? null);
  const [usernameSet, setUsernameSet] = useState<boolean | null>(null);
  const [status, setStatus] = useState<HandleStatus>("checking");
  const [handleError, setHandleError] = useState<string | null>(null);

  // Live: the name and the handle flag, from config/ — the fields registration
  // writes. Live (not onlyOnce) so a migration or an overlay submit closes the
  // overlay as soon as its write lands, locally or on the server.
  useEffect(() => {
    setUserName(bootSnapshot()?.uid === uid ? bootSnapshot()?.handle ?? null : null);
    setUsernameSet(null);
    if (!uid) return;
    const u1 = onValue(
      ref(db, `users/${uid}/config/userName`),
      (s) => setUserName(typeof s.val() === "string" ? s.val() : null),
      (err) => console.error("[LOCK-IN] config/userName listener error:", err)
    );
    const u2 = onValue(
      ref(db, `users/${uid}/config/usernameSet`),
      (s) => setUsernameSet(s.val() === true),
      (err) => console.error("[LOCK-IN] config/usernameSet listener error:", err)
    );
    return () => {
      u1();
      u2();
    };
  }, [uid]);

  // Once per sign-in, after verification: migrate a legacy handle, and repair
  // a display name the old launch-time sync overwrote with "Operator".
  useEffect(() => {
    setStatus("checking");
    setHandleError(null);
    if (!uid || !emailVerified) return;
    let cancelled = false;

    // Only the fields this needs — not the whole users/{uid} subtree.
    Promise.all([
      readOnce(`users/${uid}/config`),
      readOnce(`users/${uid}/username`),
      readOnce(`users/${uid}/usernameSet`),
    ])
      .then(([rawConfig, legacyUsername, legacyUsernameSet]) => {
        if (cancelled) return;
        const config = (rawConfig ?? {}) as {
          userName?: unknown;
          username?: unknown;
          usernameSet?: unknown;
          nameRepairedAt?: unknown;
        };

        // (b) Legacy account: handle only at the top level, none in config/.
        //     Move it into config/ and reserve it, atomically. Denied means
        //     someone else owns that handle: the overlay asks for a new one.
        if (
          config.usernameSet !== true &&
          legacyUsernameSet === true &&
          typeof legacyUsername === "string"
        ) {
          let handle: string;
          try {
            handle = normaliseHandle(legacyUsername);
          } catch {
            setHandleError("Your old handle can't be used here — pick another");
            setStatus("ready");
            return;
          }
          update(ref(db), reserveHandleUpdates(uid, handle))
            .then(() => {
              if (!cancelled) setStatus("ready");
            })
            .catch((err) => {
              if (cancelled) return;
              if (isPermissionDenied(err)) {
                setHandleError("That handle is taken — pick another");
                setStatus("ready");
              } else {
                // Transient: leave the account as it is and try again next
                // launch, rather than asking for a new handle over a blip.
                console.warn("[LOCK-IN] legacy handle migration failed:", err);
              }
            });
          return;
        }

        // (c) Repair, one-shot. The old launch-time sync wrote "Operator" over
        //     the registered display name. Restore it from the reserved handle,
        //     exactly as registration displayed it. nameRepairedAt guards it.
        if (
          config.userName === "Operator" &&
          typeof config.username === "string" &&
          config.username.length > 0 &&
          config.nameRepairedAt == null
        ) {
          const display = displayFromHandle(config.username);
          logUiEvent("name-repair", uid);
          update(ref(db), {
            [`users/${uid}/config/userName`]: display,
            [`users/${uid}/public/userName`]: display,
            [`users/${uid}/config/nameRepairedAt`]: serverTimestamp(),
          }).catch((err) => console.warn("[LOCK-IN] name repair failed:", err));
        }

        setStatus("ready");
      })
      .catch((err) => console.error("[LOCK-IN] profile read failed:", err));

    return () => {
      cancelled = true;
    };
  }, [uid, emailVerified]);

  const clearHandleError = useCallback(() => setHandleError(null), []);

  return { userName, usernameSet, status, handleError, setHandleError, clearHandleError };
}
