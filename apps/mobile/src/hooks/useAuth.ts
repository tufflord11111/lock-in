import { useEffect, useState } from "react";
import { auth, db } from "@lock-in/firebase";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  signOut,
  deleteUser,
} from "firebase/auth";
import type { User } from "firebase/auth";
import { ref, update } from "firebase/database";

/**
 * Same Firebase Auth instance and persistence chain as the desktop
 * (packages/firebase initialises it). Same 6 s hard ceiling too, so a slow
 * network on a judge's phone lands on Login instead of a spinner.
 */
export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ceiling = setTimeout(() => setLoading(false), 6000);
    const unsub = onAuthStateChanged(
      auth,
      (u) => {
        clearTimeout(ceiling);
        setUser(u);
        setLoading(false);
      },
      (err) => {
        clearTimeout(ceiling);
        console.error("[LOCK-IN mobile] auth listener error:", err);
        setLoading(false);
      }
    );
    return () => {
      clearTimeout(ceiling);
      unsub();
    };
  }, []);

  const login = (email: string, pass: string) =>
    signInWithEmailAndPassword(auth, email.trim(), pass);
  const logout = () => signOut(auth);

  /**
   * Registration, mirroring the desktop flow in apps/web/src/hooks/useAuth.ts:
   * create the account, send verification in the background, force a token
   * refresh, then write the same three nodes with the same retry strategy —
   * users/{uid}/config, users/{uid}/public (friend-visible name only), and the
   * usernames/{NAME} reservation.
   */
  const register = async (email: string, pass: string, username: string) => {
    const result = await createUserWithEmailAndPassword(auth, email.trim(), pass);
    const u = result.user;

    // Fire and forget — a failed verification mail must not block sign-up.
    sendEmailVerification(u).catch((err) =>
      console.warn("[Register] Email verification failed:", err)
    );

    // The DB write needs a fresh token or the rules reject it.
    for (let i = 0; i < 3; i++) {
      try {
        await u.getIdToken(true);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    const normalizedUsername = username.trim().toUpperCase();
    let dbWriteSuccess = false;
    let lastWriteError: unknown = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await new Promise((r) => setTimeout(r, attempt * 500));

        const updates: Record<string, unknown> = {};
        updates[`users/${u.uid}/config`] = {
          userName: normalizedUsername,
          email: u.email,
          createdAt: new Date().toISOString(),
          emailVerified: false,
          onboardingComplete: false,
          usernameSet: true,
          username: normalizedUsername,
        };
        // public holds ONLY userName — the rules reject any other field.
        updates[`users/${u.uid}/public`] = { userName: normalizedUsername };
        updates[`usernames/${normalizedUsername}`] = u.uid;

        await update(ref(db), updates);
        dbWriteSuccess = true;
        break;
      } catch (err) {
        lastWriteError = err;
        console.warn("[Register] DB write attempt", attempt, "failed:", err);
        // Deterministic refusal — the handle is taken or the per-account cap
        // rejected it. Retrying cannot help.
        if (isPermissionDenied(err)) break;
      }
    }

    if (!dbWriteSuccess) {
      if (isPermissionDenied(lastWriteError)) {
        // Roll the auth user back rather than stranding a signed-in account
        // with no profile and no handle.
        try {
          await deleteUser(u);
        } catch (rollbackErr) {
          console.error("[Register] Rollback of auth user failed:", rollbackErr);
        }
        const taken = new Error("Operator handle unavailable") as Error & { code?: string };
        taken.code = "auth/username-taken";
        throw taken;
      }
      console.warn("[Register] Proceeding without DB profile (transient write failure)");
    }
    return u;
  };

  return { user, loading, login, logout, register };
}

/**
 * True when a Realtime Database write was refused by the security rules rather
 * than failing transiently. During registration this means the handle is taken
 * or the per-account claim cap rejected it.
 */
function isPermissionDenied(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? "";
  const message = (err as { message?: string })?.message ?? "";
  return (
    code === "PERMISSION_DENIED" ||
    /permission[_ ]denied/i.test(code) ||
    /permission[_ ]denied/i.test(message)
  );
}

/** Same operator-facing messages as the desktop's parseAuthError. */
export function parseAuthError(err: unknown): string {
  const code = (err as { code?: string })?.code ?? "";
  if (code === "auth/username-taken")
    return "That operator handle is taken. Choose another.";
  if (code === "auth/invalid-credential" || code === "auth/wrong-password")
    return "Incorrect password. Try again.";
  if (code === "auth/user-not-found") return "No account found for that email.";
  if (code === "auth/email-already-in-use")
    return "This email is already in use. Switch to login instead.";
  if (code === "auth/weak-password") return "Password must be at least 6 characters.";
  if (code === "auth/invalid-email") return "Invalid email format.";
  if (code === "auth/network-request-failed") return "Network error. Check your connection.";
  if (code === "auth/too-many-requests") return "Too many attempts. Wait a moment.";
  return (err as { message?: string })?.message ?? "Sign-in failed.";
}
