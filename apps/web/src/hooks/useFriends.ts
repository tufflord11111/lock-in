import { db } from "@lock-in/firebase";
import { ref, get, set, update, remove, serverTimestamp } from "firebase/database";
import { VERIFY_FIRST, friendRequestWrite, isPermissionDenied } from "./b2";

/**
 * The handle charset, identical to the usernames/$name security rule and to
 * what registration reserves after lowercasing. Checked before any read or
 * write, so a raw string can never become a key.
 */
export const HANDLE_REGEX = /^[a-z0-9_]{1,20}$/;

export type FriendAddErrorCode = "invalid" | "not-found" | "self" | "already" | "unverified";

export class FriendAddError extends Error {
  constructor(public code: FriendAddErrorCode, message: string) {
    super(message);
    this.name = "FriendAddError";
  }
}

/**
 * Tell `to` that `from` added them, so they can add back (1.3.1 B2). Separate
 * from, and after, from's own friends entry: the rules check that entry, and
 * the rules before 1.3.1 refuse friendRequests/ entirely, which must not
 * undo the add. Best effort.
 */
export async function sendFriendRequest(from: string, to: string): Promise<void> {
  const r = friendRequestWrite(from, to);
  await set(ref(db, r.path), { from: r.from, at: serverTimestamp() }).catch((err) =>
    console.warn("[LOCK-IN] friend request not sent:", err)
  );
}

export function useFriends(currentUserId: string) {
  /**
   * Add a friend by their operator handle.
   *
   * The friends list is keyed by uid, so the handle must be resolved first.
   * usernames/{handle} is readable by any signed-in user as a single-key read
   * (only listing or querying the whole index is restricted), so no rules
   * change is needed. The old version wrote whatever was typed as the key,
   * which produced "friends" that could never resolve.
   */
  const addFriend = async (rawHandle: string): Promise<void> => {
    if (!currentUserId) throw new Error("User not authenticated");

    // 1. Normalise and validate before touching the database.
    const handle = rawHandle.trim().toLowerCase();
    if (!HANDLE_REGEX.test(handle)) {
      throw new FriendAddError(
        "invalid",
        "Handles are 1–20 letters, numbers or underscores."
      );
    }

    // 2. Resolve the handle to a uid.
    const snap = await get(ref(db, `usernames/${handle}`));
    const uid = snap.val();
    if (typeof uid !== "string" || uid.length === 0) {
      throw new FriendAddError("not-found", "No operator with that handle");
    }

    // 3. Not yourself, and not someone already in the Pack.
    if (uid === currentUserId) {
      throw new FriendAddError("self", "That's your own handle.");
    }
    const existing = await get(ref(db, `users/${currentUserId}/friends/${uid}`));
    if (existing.exists()) {
      throw new FriendAddError("already", "Already in your Pack");
    }

    // 4. Only now write — keyed by the resolved uid, never the typed text.
    //    The rules take it only from a verified email (1.3.1 B2).
    try {
      await set(ref(db, `users/${currentUserId}/friends/${uid}`), true);
    } catch (err) {
      if (isPermissionDenied(err)) throw new FriendAddError("unverified", VERIFY_FIRST);
      throw err;
    }
    // 5. Let them know, so they can add back.
    await sendFriendRequest(currentUserId, uid);
  };

  /** Add back someone who added you: your entry, and their request goes, together. */
  const addBack = async (fromUid: string): Promise<void> => {
    if (!currentUserId) throw new Error("User not authenticated");
    try {
      await update(ref(db), {
        [`users/${currentUserId}/friends/${fromUid}`]: true,
        [`friendRequests/${currentUserId}/${fromUid}`]: null,
      });
    } catch (err) {
      if (isPermissionDenied(err)) throw new FriendAddError("unverified", VERIFY_FIRST);
      throw err;
    }
  };

  /** Dismiss a request without adding back. */
  const dismissRequest = (fromUid: string): Promise<void> =>
    remove(ref(db, `friendRequests/${currentUserId}/${fromUid}`));

  return { addFriend, addBack, dismissRequest };
}
