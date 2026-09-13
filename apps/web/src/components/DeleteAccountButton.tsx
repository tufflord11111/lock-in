import { useState } from "react";
import { Trash2 } from "lucide-react";
import { auth, db } from "@lock-in/firebase";
import { ref, get, update } from "firebase/database";
import { signOut, deleteUser } from "firebase/auth";

/**
 * F6 — account deletion.
 *
 * Removes everything under users/{uid} and releases the usernames/{NAME}
 * reservation, then signs out (and deletes the auth user when the session is
 * recent enough). Two-step confirm so a stray click can't wipe an account.
 */
export function DeleteAccountButton({ userId }: { userId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      // Find the username reservation to release. It is stored uppercased.
      let name: string | null = null;
      const top = await get(ref(db, `users/${userId}/username`));
      if (typeof top.val() === "string") name = top.val();
      if (!name) {
        const cfg = await get(ref(db, `users/${userId}/config/username`));
        if (typeof cfg.val() === "string") name = cfg.val();
      }

      // One multi-path write removes the whole subtree and the reservation.
      const updates: Record<string, null> = { [`users/${userId}`]: null };
      if (name) updates[`usernames/${name.toUpperCase()}`] = null;
      await update(ref(db), updates);

      // Best-effort auth-user deletion; falls back to sign-out if Firebase
      // requires a recent login. Either way the app returns to Login.
      try {
        if (auth.currentUser) await deleteUser(auth.currentUser);
        else await signOut(auth);
      } catch {
        await signOut(auth);
      }
    } catch (err) {
      setError(String((err as { message?: string })?.message ?? err));
      setBusy(false);
    }
  };

  return (
    <section className="bg-white border-2 border-[#B3261E] p-6 rounded-3xl shadow-[4px_4px_0px_#7f1d1d]">
      <div className="flex items-center gap-3 mb-4">
        <Trash2 size={18} className="text-[#B3261E]" />
        <h2 className="text-[10px] font-black uppercase tracking-[0.2em] text-[#B3261E]/60">Danger Zone</h2>
      </div>
      <p className="text-sm font-black text-[#002855] uppercase tracking-tight">Delete account</p>
      <p className="text-[9px] font-bold text-[#002855]/40 mt-1 mb-4 leading-relaxed">
        Permanently removes all your data — sessions, blocklists, history, presence, and
        your operator handle. This cannot be undone.
      </p>

      {error && (
        <p className="mb-3 text-[9px] font-bold text-[#B3261E] bg-[#B3261E]/5 border border-[#B3261E]/20 rounded-lg p-2 break-words">
          {error}
        </p>
      )}

      {confirming ? (
        <div className="flex gap-3">
          <button
            onClick={() => setConfirming(false)}
            disabled={busy}
            className="flex-1 py-3 border-2 border-[#002855] bg-white text-[#002855] font-black text-[10px] uppercase tracking-widest rounded-xl disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={handleDelete}
            disabled={busy}
            className="flex-1 py-3 bg-[#B3261E] border-2 border-[#7f1d1d] text-white font-black text-[10px] uppercase tracking-widest rounded-xl disabled:opacity-40"
          >
            {busy ? "Deleting…" : "Delete everything"}
          </button>
        </div>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          className="w-full py-3 bg-white border-2 border-[#B3261E] text-[#B3261E] font-black text-[10px] uppercase tracking-widest rounded-xl hover:bg-[#B3261E] hover:text-white transition-colors"
        >
          Delete my account
        </button>
      )}
    </section>
  );
}
