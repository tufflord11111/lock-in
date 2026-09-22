import { db } from "@lock-in/firebase";
import { ref, get, set } from "firebase/database";

/**
 * The handle charset, identical to the usernames/$name security rule and to
 * what registration reserves after lowercasing. Checked before any read or
 * write, so a raw string can never become a key.
 */
export const HANDLE_REGEX = /^[a-z0-9_]{1,20}$/;

export type FriendAddErrorCode = "invalid" | "not-found" | "self" | "already";

export class FriendAddError extends Error {
  constructor(public code: FriendAddErrorCode, message: string) {
    super(message);
    this.name = "FriendAddError";
  }
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
    await set(ref(db, `users/${currentUserId}/friends/${uid}`), true);
  };

  return { addFriend };
}
