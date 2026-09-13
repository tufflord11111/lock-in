import { useState } from "react";
import { parseAuthError } from "../hooks/useAuth";

type Props = {
  onLogin: (email: string, pass: string) => Promise<unknown>;
  onRegister: (email: string, pass: string, username: string) => Promise<unknown>;
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Letters, numbers and underscore only. A handle becomes a Firebase key at
// usernames/{NAME}, and keys may not contain . # $ [ ] or /, so the charset is
// deliberately tighter than the desktop's.
const USERNAME_REGEX = /^[A-Za-z0-9_]+$/;

export function Login({ onLogin, onRegister }: Props) {
  // Deep link: the extension's "Create account" link lands on #register.
  const [view, setView] = useState<"login" | "register">(
    typeof window !== "undefined" && window.location.hash === "#register" ? "register" : "login"
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchTo = (next: "login" | "register") => {
    setError(null);
    setPassword("");
    setConfirm("");
    setView(next);
    if (typeof window !== "undefined") {
      window.location.hash = next === "register" ? "#register" : "";
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (view === "register") {
      if (!EMAIL_REGEX.test(email.trim())) {
        setError("Please enter a valid email address.");
        return;
      }
      if (!username.trim()) {
        setError("Operator handle cannot be empty.");
        return;
      }
      if (!USERNAME_REGEX.test(username.trim())) {
        setError("Handle can use letters, numbers and underscore only.");
        return;
      }
      if (password.length < 6) {
        setError("Password must be at least 6 characters.");
        return;
      }
      if (password !== confirm) {
        setError("Passwords do not match.");
        return;
      }
    }

    setBusy(true);
    try {
      if (view === "register") {
        await onRegister(email, password, username);
      } else {
        await onLogin(email, password);
      }
    } catch (err) {
      setPassword("");
      setConfirm("");
      setError(parseAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  const registering = view === "register";

  return (
    <div className="screen center">
      <div className="brand">
        <div className="brand-mark">L</div>
        <h1>Lock-In</h1>
      </div>
      <p className="eyebrow">
        {registering ? "Register new operator" : "Establish secure link to cockpit"}
      </p>

      <form className="card" onSubmit={submit} style={{ width: "100%" }}>
        {registering && (
          <label>
            Operator handle
            <input
              type="text"
              autoCapitalize="characters"
              autoComplete="username"
              maxLength={20}
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. IRONCLAD"
            />
          </label>
        )}

        <label>
          Comm link (email)
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="operator@secure.net"
          />
        </label>

        <label>
          Security clearance
          <input
            type="password"
            autoComplete={registering ? "new-password" : "current-password"}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </label>

        {registering && (
          <label>
            Confirm clearance
            <input
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="••••••••"
            />
          </label>
        )}

        {error && <div className="error">⚠ {error}</div>}

        <button className="btn gold" type="submit" disabled={busy}>
          {busy
            ? registering
              ? "Creating…"
              : "Syncing…"
            : registering
              ? "Create account"
              : "Engage Protocol"}
        </button>

        <button
          className="btn ghost small"
          type="button"
          onClick={() => switchTo(registering ? "login" : "register")}
        >
          {registering ? "Already have an account? Log in" : "First time? Create account"}
        </button>
      </form>

      <p className="muted">
        {registering
          ? "Your handle is public to your pack and cannot be changed later."
          : "Use the same account as your desktop Lock-In."}
      </p>
    </div>
  );
}
