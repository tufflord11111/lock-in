/**
 * Screen harness — development only, never imported by the app.
 *
 * Mounts one screen at a time with fixture props so every screen can be looked
 * at in every theme without a signed-in account. Firebase reads inside the
 * screens simply return nothing here, so what you see is each screen's empty
 * state.
 *
 *   /harness.html?screen=dashboard&theme=botanical&accent=orange
 */
import { createRoot } from "react-dom/client";
import "@lock-in/ui/src/global.css";
import "./theme/tokens.css";
import { ThemeProvider, applyTheme, type AccentName, type ThemeName } from "./theme/ThemeProvider";
import { Login } from "./screens/Login";
import { Dashboard } from "./screens/Dashboard";
import { PerformanceLog } from "./screens/PerformanceLog";
import { ThePack } from "./screens/ThePack";
import { BlockRegistry } from "./screens/BlockRegistry";
import { VerificationGate } from "./components/VerificationGate";
import WelcomeSequence from "./components/WelcomeSequence";
import { DeleteAccountButton } from "./components/DeleteAccountButton";
import { WriteFailureToasts } from "./components/WriteFailureToasts";
import { AppearancePicker } from "./theme/AppearancePicker";
import { reportWriteFailure } from "./writeFailures";

const params = new URLSearchParams(location.search);
const theme = (params.get("theme") ?? "operator") as ThemeName;
const accent = (params.get("accent") ?? "orange") as AccentName;
const screen = params.get("screen") ?? "login";

// The provider reads the localStorage mirror on mount, so seed it first —
// otherwise it would immediately put the previous theme back.
localStorage.setItem("lockin.theme", theme);
localStorage.setItem("lockin.accent", accent);
applyTheme(theme, accent);

const UID = "harness-user";
const noop = () => {};
const asyncNoop = async () => {};

const INTENTIONS = [
  { id: "1", text: "Finish the theme system", completed: true },
  { id: "2", text: "Write the release notes", completed: false },
  { id: "3", text: "Check the contrast table", completed: false },
];

function Shell({ children, pad = true }: { children: React.ReactNode; pad?: boolean }) {
  return (
    <div className="min-h-screen bg-ground" style={{ backgroundImage: "var(--grid-image)", backgroundSize: "var(--grid-size)" }}>
      <div className={pad ? "max-w-[1600px] mx-auto px-10 py-10" : ""}>{children}</div>
    </div>
  );
}

function pick() {
  switch (screen) {
    case "login":
      return <Login onLogin={asyncNoop} onRegister={asyncNoop} onForgotPassword={asyncNoop} />;
    case "verification":
      return (
        <VerificationGate
          email="operator@example.com"
          onCheckStatus={async () => false}
          onResend={asyncNoop}
          onLogout={noop}
        />
      );
    case "welcome":
      return <WelcomeSequence userName="OPERATOR" userId={UID} onComplete={noop} />;
    case "dashboard":
      return (
        <Shell>
          <Dashboard
            userId={UID}
            onStartSession={noop}
            isActive={false}
            timeLeft={0}
            taskLabel=""
            onEndSession={noop}
            intentions={INTENTIONS}
            setIntentions={noop}
            blocklistHydrated
          />
        </Shell>
      );
    case "dashboard-active":
      return (
        <Shell>
          <Dashboard
            userId={UID}
            onStartSession={noop}
            isActive
            timeLeft={1523}
            taskLabel="Ship 1.2.5"
            onEndSession={noop}
            intentions={INTENTIONS}
            setIntentions={noop}
            blocklistHydrated
          />
        </Shell>
      );
    case "planner":
      return (
        <Shell>
          <PerformanceLog userId={UID} />
        </Shell>
      );
    case "pack":
      return (
        <Shell>
          <ThePack userId={UID} />
        </Shell>
      );
    case "blocks":
      return (
        <Shell>
          <BlockRegistry
            userId={UID}
            userName="OPERATOR"
            blockedApps={["discord.exe", "steam.exe"]}
            addBlock={asyncNoop}
            removeBlock={asyncNoop}
            totalMinutesToday={84}
            _updateAutostart={asyncNoop}
            isSyncing={false}
            engineOffline={false}
          />
        </Shell>
      );
    case "appearance":
      return (
        <Shell>
          <div className="max-w-[560px]">
            <AppearancePicker />
          </div>
        </Shell>
      );
    case "delete":
      return (
        <Shell>
          <div className="max-w-[560px]">
            <DeleteAccountButton userId={UID} />
          </div>
        </Shell>
      );
    case "toasts":
      reportWriteFailure("Your session minutes didn't save, so your streak won't count this session.");
      reportWriteFailure("Your session minutes didn't save, so your streak won't count this session.");
      reportWriteFailure("You're offline — your session ended locally but your extension may keep blocking sites until you reconnect.", undefined, "info", { sticky: true });
      return (
        <Shell>
          <WriteFailureToasts />
        </Shell>
      );
    default:
      return <Shell>Unknown screen: {screen}</Shell>;
  }
}

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>{pick()}</ThemeProvider>
);
