import { useEffect, useCallback } from "react";
import { db } from "@lock-in/firebase";
import { ref, onValue, onDisconnect, set, serverTimestamp } from "firebase/database";

export function usePresence(userId: string | undefined) {
  const updatePresence = useCallback(async (state: "online" | "offline" | "locked-in") => {
    if (!userId) return;
    const presenceRef = ref(db, `users/${userId}/presence`);
    try {
      await set(presenceRef, {
        state,
        lastChanged: serverTimestamp(),
      });
    } catch (err) {
      console.error("[Presence] Failed to update presence:", err);
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;

    const connectedRef = ref(db, ".info/connected");
    const presenceRef = ref(db, `users/${userId}/presence`);

    const unsubscribe = onValue(connectedRef, (snapshot) => {
      if (snapshot.val() === true) {
        // We are connected (or reconnected)!
        
        // 1. Set up onDisconnect behavior
        const disconnectRef = onDisconnect(presenceRef);
        disconnectRef.set({
          state: "offline",
          lastChanged: serverTimestamp(),
        }).then(() => {
          // 2. Set current state to online
          set(presenceRef, {
            state: "online",
            lastChanged: serverTimestamp(),
          });
        }).catch((err) => {
          console.error("[Presence] onDisconnect setup failed:", err);
        });
      }
    });

    return () => {
      unsubscribe();
    };
  }, [userId]);

  return { updatePresence };
}
