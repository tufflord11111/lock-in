import { useState } from "react";
import { useAuth } from "./hooks/useAuth";
import { Login } from "./screens/Login";
import { Session } from "./screens/Session";
import { Pack } from "./screens/Pack";

type Tab = "session" | "pack";

export function App() {
  const { user, loading, login, logout, register } = useAuth();
  const [tab, setTab] = useState<Tab>("session");

  if (loading) {
    return (
      <div className="screen center">
        <div className="spinner" />
        <p className="eyebrow">Syncing cockpit…</p>
      </div>
    );
  }

  if (!user) return <Login onLogin={login} onRegister={register} />;

  return (
    <div className="screen">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="brand">
          <div className="brand-mark">L</div>
          <h1 style={{ fontSize: 20 }}>Lock-In</h1>
        </div>
        <button className="btn ghost small" style={{ width: "auto", padding: "0 12px" }} onClick={logout}>
          Sign out
        </button>
      </div>

      {tab === "session" ? <Session uid={user.uid} /> : <Pack />}

      <nav className="tabs">
        <button className={`tab ${tab === "session" ? "on" : ""}`} onClick={() => setTab("session")}>
          Session
        </button>
        <button className={`tab ${tab === "pack" ? "on" : ""}`} onClick={() => setTab("pack")}>
          The Pack
        </button>
      </nav>
    </div>
  );
}
