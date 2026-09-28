import { useState } from "react";
import { Trash2 } from "lucide-react";
import { auth, db } from "@lock-in/firebase";
import { ref, get, update, query, orderByValue, equalTo } from "firebase/database";
import type { DataSnapshot } from "firebase/database";
import {
  signOut,
  deleteUser,
  reauthenticateWithCredential,
  EmailAuthProvider,
} from "firebase/auth";
import { guardWrite, reportWriteFailure } from "../writeFailures";

/**
 * F6 — account deletion.
 *
 * Removes everything under users/{uid} and releases EVERY usernames/{key} this
 * account owns, then signs out (and deletes the auth user when the session is
 * recent enough). Two-step confirm so a stray click can't wipe an account.
 *
 * The reservation keys are found by reverse-querying the index by value, never
 * by deriving them from config.username. Those two drifted in production —
 * different case, dots the index key never had, and accounts holding several
 * handles — and because this is one atomic multi-path write, a single wrong or
 * missing key made the ENTIRE delete fail, leaving the account fully intact.
 */
export function DeleteAccountButton({ userId }: { userId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when Firebase refuses the auth-user delete on a stale sign-in. The
  // data is already gone at that point; only the credential is left.
  const [needsReauth, setNeedsReauth] = useState(false);
  const [password, setPassword] = useState("");
  const [reauthError, setReauthError] = useState<string | null>(null);

  /**
   * Delete the auth user, dealing with the two ways Firebase can refuse.
   *
   * The data write has already committed by the time this runs, so every path
   * here ends with the operator signed out — but a silent sign-out used to
   * make a refused delete look identical to a successful one, leaving the
   * email quietly registered and unable to re-register.
   */
  const removeAuthUser = async () => {
    const current = auth.currentUser;
    if (!current) {
      await signOut(auth);
      return;
    }
    try {
      await deleteUser(current);
    } catch (err) {
      const code = (err as { code?: string })?.code ?? "unknown";

      // Recoverable: the sign-in is simply too old. Stay signed in — the
      // credential is the only thing that can authorise the retry.
      if (code === "auth/requires-recent-login") {
        setNeedsReauth(true);
        setBusy(false);
        return;
      }

      // Everything else: the data is gone and we cannot delete the account, so
      // say which error it was instead of dropping it into the console.
      reportWriteFailure(
        `Your data is deleted, but your account couldn't be removed (${code}). The sign-in email is still registered — contact support if you need it released.`,
        err
      );
      await signOut(auth);
    }
  };

  const handleDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      // Every handle this account owns, straight from the index. The rules
      // permit exactly this query shape (orderByValue + equalTo own uid).
      const owned = await get(
        query(ref(db, "usernames"), orderByValue(), equalTo(userId))
      );

      // One multi-path write removes the whole subtree and every reservation.
      const updates: Record<string, null> = { [`users/${userId}`]: null };
      owned.forEach((entry: DataSnapshot) => {
        if (entry.key) updates[`usernames/${entry.key}`] = null;
      });

      // Must stay atomic: the subtree and the reservations go together or
      // nothing goes. `.then(() => true)` gives guardWrite a truthy success
      // value to report, since update() itself resolves undefined.
      const wrote = await guardWrite(
        update(ref(db), updates).then(() => true as const),
        "Couldn't delete your account. Nothing was removed — your data and handle are both still there. Check your connection and try again."
      );

      // Do NOT delete the auth user if the data write failed: that would
      // orphan the subtree with no signed-in account left to retry from.
      if (!wrote) {
        setBusy(false);
        return;
      }

      await removeAuthUser();
    } catch (err) {
      setError(String((err as { message?: string })?.message ?? err));
      setBusy(false);
    }
  };

  /** Re-authenticate with the password just entered, then retry the delete. */
  const confirmReauth = async () => {
    const current = auth.currentUser;
    if (!current?.email) {
      await cancelReauth();
      return;
    }
    setBusy(true);
    setReauthError(null);
    try {
      await reauthenticateWithCredential(
        current,
        EmailAuthProvider.credential(current.email, password)
      );
      await deleteUser(current);
      // Signed out implicitly by the delete; nothing left to clean up.
    } catch (err) {
      const code = (err as { code?: string })?.code ?? "unknown";
      setBusy(false);
      setPassword("");
      // Wrong password is worth another try, so keep the prompt open.
      setReauthError(
        code === "auth/wrong-password" || code === "auth/invalid-credential"
          ? "That password didn't match. Try again."
          : `Couldn't confirm your password (${code}).`
      );
    }
  };

  /** Give up on removing the credential, but be explicit about what remains. */
  const cancelReauth = async () => {
    setNeedsReauth(false);
    setPassword("");
    reportWriteFailure(
      "Your data is deleted, but your sign-in email is still registered. Sign in again and delete within a few minutes of signing in to remove it."
    );
    await signOut(auth);
  };

  return (
    <section className="bg-surface border-1 border-danger p-6 rounded-2xl shadow-[4px_4px_0px_var(--danger-shadow)]">
      <div className="flex items-center gap-3 mb-4">
        <Trash2 size={18} className="text-danger" />
        <h2 className="text-[10px] font-black label-plain tracking-[0.2em] text-danger/60">Danger Zone</h2>
      </div>
      <p className="text-sm font-black text-ink label-plain tracking-tight">Delete account</p>
      <p className="text-[9px] font-bold text-ink/40 mt-1 mb-4 leading-relaxed">
        Permanently removes all your data — sessions, blocklists, history, presence, and
        your operator handle. This cannot be undone.
      </p>

      {error && (
        <p className="mb-3 text-[9px] font-bold text-danger bg-danger/5 border border-danger/20 rounded-md p-2 break-words">
          {error}
        </p>
      )}

      {needsReauth ? (
        <div className="flex flex-col gap-3">
          <p className="text-[9px] font-bold text-ink/60 leading-relaxed">
            Your data is already deleted. Confirm your password to remove the
            account itself — Firebase requires a recent sign-in for this.
          </p>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && password && !busy) confirmReauth();
            }}
            placeholder="Password"
            autoFocus
            className="w-full px-4 py-3 border-1 border-ink rounded-lg text-[11px] font-bold text-ink placeholder:text-ink/30 focus:outline-none"
          />
          {reauthError && (
            <p className="text-[9px] font-bold text-danger break-words">
              {reauthError}
            </p>
          )}
          <div className="flex gap-3">
            <button
              onClick={cancelReauth}
              disabled={busy}
              className="flex-1 py-3 border-1 border-ink bg-surface text-ink font-black text-[10px] label-sm rounded-lg disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              onClick={confirmReauth}
              disabled={busy || !password}
              className="flex-1 py-3 bg-danger border-1 border-danger-shadow text-surface-inverse font-black text-[10px] label-sm rounded-lg disabled:opacity-40"
            >
              {busy ? "Deleting…" : "Confirm & delete"}
            </button>
          </div>
        </div>
      ) : confirming ? (
        <div className="flex gap-3">
          <button
            onClick={() => setConfirming(false)}
            disabled={busy}
            className="flex-1 py-3 border-1 border-ink bg-surface text-ink font-black text-[10px] label-sm rounded-lg disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={handleDelete}
            disabled={busy}
            className="flex-1 py-3 bg-danger border-1 border-danger-shadow text-surface-inverse font-black text-[10px] label-sm rounded-lg disabled:opacity-40"
          >
            {busy ? "Deleting…" : "Delete everything"}
          </button>
        </div>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          className="w-full py-3 bg-surface border-1 border-danger text-danger font-black text-[10px] label-sm rounded-lg hover:bg-danger hover:text-surface-inverse transition-colors"
        >
          Delete my account
        </button>
      )}
    </section>
  );
}
