import { db } from "@lock-in/firebase";
import { ref, set } from "firebase/database";

export function useFriends(currentUserId: string) {
  const addFriend = async (friendId: string) => {
    if (!friendId || !friendId.trim()) {
      throw new Error("Invalid Friend ID");
    }
    
    if (!currentUserId) {
      throw new Error("User not authenticated");
    }

    const friendRef = ref(db, `users/${currentUserId}/friends/${friendId.trim()}`);
    
    // Using set to inject the friend into the list. 
    // We use 'true' as the value to signify the relationship exists.
    await set(friendRef, true);
  };

  return { addFriend };
}
