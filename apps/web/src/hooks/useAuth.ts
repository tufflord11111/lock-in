import { useState, useEffect, useRef } from "react";
import { auth, db } from "@lock-in/firebase";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail as firebaseSendPasswordResetEmail,
  signOut,
  deleteUser,
} from "firebase/auth";
import type { User } from "firebase/auth";
import { ref, update, get, child } from "firebase/database";

/**
 * True when a Realtime Database write was refused by the security rules, as
 * opposed to failing transiently. For registration this means the handle is
 * already claimed — deterministic, so there is no point retrying and the
 * operator must be told.
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

/** Translates Firebase error codes into operator-friendly messages */
export function parseAuthError(err: any): string {
  const code: string = err?.code ?? "";
  
  if (code === 'PERMISSION_DENIED' || 
      err?.message?.includes('Permission denied') ||
      err?.message?.includes('permission_denied')) {
    return 'Account created. Please log in with your credentials.';
  }

  if (code === "auth/invalid-credential" || code === "auth/wrong-password")
    return "Incorrect password. Try again or reset your access key.";
  if (code === "auth/user-not-found")
    return "No account found for that comm link. Register first.";
  if (code === "auth/email-already-in-use")
    return "This email is already in use. Switch to login mode.";
  if (code === "auth/weak-password")
    return "Password must be at least 6 characters.";
  if (code === "auth/invalid-email")
    return "Invalid email format. Double-check your comm link.";
  if (code === "auth/network-request-failed")
    return "Network error. Check your connection and retry.";
  if (code === "auth/too-many-requests")
    return "Too many attempts. Wait a moment before retrying.";
  if (code === "auth/username-taken")
    return "This username is already taken. Choose another handle.";
  if (code === "auth/profile-write-failed")
    return "We couldn't set up your profile. Check your connection and try again.";
  if (code === "auth/profile-write-failed-kept")
    return "Your account was created, but your profile couldn't be saved. Check your connection, then sign in — you'll pick your handle then.";
  return err?.message ?? "Authentication protocol failed.";
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  /** emailVerified is a snapshot separate from `user` so we can force-refresh it */
  const [emailVerified, setEmailVerified] = useState(false);
  /** Set to true immediately after a successful registration — triggers onboarding */
  const [isNewUser, setIsNewUser] = useState(false);
  /** True when the auth listener never fired within the 6 s ceiling */
  const [authDegraded, setAuthDegraded] = useState(false);
  /** The verification email at registration failed to send. */
  const [verificationSendFailed, setVerificationSendFailed] = useState(false);
  /**
   * True while register() runs. The auth listener fires as soon as the
   * account is created — before the profile write — and used to hand App a
   * user right then, which unmounted <Login>. Any error register() threw
   * afterwards (a taken handle, a failed profile write) landed on a component
   * that no longer existed, and the operator saw nothing. The listener now
   * holds the user back until register() has finished, so the form stays up.
   */
  const registeringRef = useRef(false);

  useEffect(() => {
    // `settled` ensures setLoading(false) fires exactly once regardless of
    // which path — normal callback, error callback, or hard timeout — wins.
    const startMs = performance.now();
    let settled = false;
    const finish = (hasUser: boolean, degraded: boolean) => {
      if (!settled) {
        settled = true;
        const ms = Math.round(performance.now() - startMs);
        console.info('[LOCK-IN] auth settled in', ms, 'ms', { hasUser, degraded });
        setLoading(false);
      }
    };

    // Hard ceiling: if onAuthStateChanged never fires (IndexedDB hang in
    // WebView2, total network outage, etc.) force the app past the loading
    // gate so the user sees the retry screen instead of spinning forever.
    const authTimeout = setTimeout(() => {
      console.error('[LOCK-IN] auth listener never fired within 6 s — booting degraded');
      setAuthDegraded(true);
      finish(false, true);
    }, 6000);

    const unsubscribe = onAuthStateChanged(
      auth,
      async (u) => {
        clearTimeout(authTimeout);
        // register() publishes the final state itself when it finishes, and
        // writes the profile itself — so no backfill race either.
        if (registeringRef.current) return;
        setUser(u);
        setEmailVerified(u?.emailVerified ?? false);

        if (u) {
          try {
            const configRef = child(ref(db), `users/${u.uid}/config`);

            // Race the Firebase RTDB read against a 5 s timeout.
            // get() can hang indefinitely when the network is not ready.
            const networkTimeout = new Promise<null>((_, reject) =>
              setTimeout(() => reject(new Error('Network timeout')), 5000)
            );
            const snapshot = await Promise.race([get(configRef), networkTimeout]);

            if (snapshot && !snapshot.exists()) {
              const fallbackName = u.email?.split('@')[0].toUpperCase() || "OPERATOR";
              await update(ref(db), {
                [`users/${u.uid}/config`]: {
                  userName: fallbackName,
                  email: u.email,
                  createdAt: new Date().toISOString(),
                  emailVerified: u.emailVerified,
                  onboardingComplete: false,
                  usernameSet: false,
                },
                // Seed the friend-visible name alongside the private config so
                // a recovered profile is renderable in The Pack immediately.
                [`users/${u.uid}/public`]: { userName: fallbackName },
              });
            }
          } catch (err) {
            console.warn('[LOCK-IN] config fetch failed (network or timeout):', err);
          }
        }

        finish(!!u, false);
      },
      (err) => {
        // onAuthStateChanged error callback — fired when the listener itself
        // errors (permission denied on the auth stream, etc.)
        clearTimeout(authTimeout);
        console.error('[LOCK-IN] auth listener error:', err);
        setAuthDegraded(true);
        finish(false, true);
      }
    );

    return () => {
      clearTimeout(authTimeout);
      unsubscribe();
    };
  }, []);

  const login = (email: string, pass: string) =>
    signInWithEmailAndPassword(auth, email, pass);

  const register = async (email: string, pass: string, username: string) => {
    registeringRef.current = true;
    setVerificationSendFailed(false);
    try {
      return await registerInner(email, pass, username);
    } finally {
      registeringRef.current = false;
      // Publish whatever auth state registration ended in: the new user on
      // success, null after a rollback or sign-out.
      const current = auth.currentUser;
      setUser(current);
      setEmailVerified(current?.emailVerified ?? false);
    }
  };

  /**
   * Undo a registration that can't complete, so the operator stays on the form
   * and can retry. Deleting the auth user needs the network; if that fails too,
   * sign out (local) so they are at least returned to the form, and say so.
   */
  const rollBackRegistration = async (u: User): Promise<boolean> => {
    try {
      await deleteUser(u);
      return true;
    } catch (rollbackErr) {
      console.error('[Register] Rollback of auth user failed:', rollbackErr);
      await signOut(auth).catch(() => {});
      return false;
    }
  };

  const registerInner = async (email: string, pass: string, username: string) => {
    // Step 1: Create auth account
    const result = await createUserWithEmailAndPassword(auth, email, pass);
    const u = result.user;

    // Step 2: Send verification email
    // Don't await — let it send in background. A failure used to be a
    // console.warn only; the verification screen then waited for an email
    // that was never sent. It now shows an error with the resend button.
    sendEmailVerification(u).catch(err => {
      console.warn('[Register] Email verification failed:', err);
      setVerificationSendFailed(true);
    });

    // Step 3: Force token refresh with retry
    let tokenRefreshed = false;
    for (let i = 0; i < 3; i++) {
      try {
        await u.getIdToken(true);
        tokenRefreshed = true;
        break;
      } catch {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    
    console.log('[Register] Token refreshed:', tokenRefreshed);

    // Step 4: Write to database with retry
    // Two forms, deliberately. `displayName` keeps the shouty operator styling
    // the UI renders. `handleKey` is the canonical identity and the ONLY thing
    // written to usernames/: the rules reject any key that is not lowercase
    // [a-z0-9_], matching the client charset validator after normalisation.
    // Writing the display form as the key is what produced the live index
    // drift (XIAOHONGLOVER next to lowercase handles), so never reuse it here.
    const displayName = username.trim().toUpperCase();
    const handleKey = username.trim().toLowerCase();
    let dbWriteSuccess = false;
    
    let lastWriteError: unknown = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await new Promise(r => setTimeout(r, attempt * 500));

        const updates: Record<string, any> = {};
        updates[`users/${u.uid}/config`] = {
          userName: displayName,
          email: u.email,
          createdAt: new Date().toISOString(),
          emailVerified: false,
          onboardingComplete: false,
          usernameSet: true,
          // The reservation key, so the profile records what it actually owns.
          username: handleKey,
        };
        // Friend-visible name. public holds ONLY this field — the rules
        // reject anything else under it.
        updates[`users/${u.uid}/public`] = { userName: displayName };
        updates[`usernames/${handleKey}`] = u.uid;
        
        await update(ref(db), updates);
        dbWriteSuccess = true;
        console.log('[Register] DB write success on attempt', attempt);
        break;
      } catch (err) {
        lastWriteError = err;
        console.warn('[Register] DB write attempt', attempt, 'failed:', err);
        // A permission denial is deterministic: the handle is already claimed
        // by someone. (There is no per-account handle cap — the rules cannot
        // express one without a full index read.) Retrying cannot help.
        if (isPermissionDenied(err)) break;
        if (attempt === 3) {
          console.error('[Register] All DB write attempts failed');
        }
      }
    }

    if (!dbWriteSuccess) {
      if (isPermissionDenied(lastWriteError)) {
        // Do not strand a signed-in account with no profile and no handle.
        // Roll the auth user back so the operator can pick another handle.
        await rollBackRegistration(u);
        const taken = new Error('Operator handle unavailable') as Error & { code?: string };
        taken.code = 'auth/username-taken';
        throw taken;
      }
      // Transient failure (network), three times over. This used to carry on
      // with an account that had no profile and no reserved handle, silently —
      // the handle the operator chose was simply lost. Now it stops: roll back
      // if possible and keep them on the form with the error.
      const removed = await rollBackRegistration(u);
      const failed = new Error('Profile write failed') as Error & { code?: string };
      failed.code = removed ? 'auth/profile-write-failed' : 'auth/profile-write-failed-kept';
      throw failed;
    }

    // Flag as new so App.tsx shows the WelcomeSequence after verification
    setIsNewUser(true);
    return u;
  };

  /**
   * Forces a reload of the Firebase Auth user token so emailVerified
   * reflects the latest server state. Call this when the operator clicks
   * "Check Status" in the VerificationGate.
   */
  const reloadUser = async (): Promise<boolean> => {
    if (!auth.currentUser) return false;
    await auth.currentUser.reload();
    const verified = auth.currentUser.emailVerified;
    setEmailVerified(verified);

    if (verified) {
      // Patch the DB flag so other parts of the system can trust it
      const configRef = ref(db, `users/${auth.currentUser.uid}/config`);
      // KNOWN AND ACCEPTED DRIFT: this mirrors the auth record's verified flag
      // into the profile for other surfaces to read. If it fails, the database
      // flag stays false while Firebase Auth says verified. Nothing gates on
      // the database copy — the app reads emailVerified from the auth user —
      // so the drift is cosmetic and deliberately not surfaced to the user.
      await update(configRef, { emailVerified: true }).catch(() => {});
    }

    return verified;
  };

  const resendVerificationEmail = async () => {
    if (!auth.currentUser) return;
    await sendEmailVerification(auth.currentUser);
  };

  const sendPasswordResetEmail = async (email: string) => {
    await firebaseSendPasswordResetEmail(auth, email);
  };

  const logout = async () => {
    try {
      await signOut(auth);
    } catch (err) {
      console.error("[Auth] Logout failed:", err);
    }
  };

  /** Called by App once onboarding has been shown so it never fires again */
  const clearNewUserFlag = () => setIsNewUser(false);

  /** Let the UI explicitly declare "we're going offline" — clears degraded flag */
  const forceOfflineMode = () => {
    setAuthDegraded(false);
    setLoading(false);
  };

  return {
    user,
    loading,
    emailVerified,
    isNewUser,
    authDegraded,
    verificationSendFailed,
    clearNewUserFlag,
    login,
    register,
    logout,
    reloadUser,
    resendVerificationEmail,
    sendPasswordResetEmail,
    forceOfflineMode,
  };
}
