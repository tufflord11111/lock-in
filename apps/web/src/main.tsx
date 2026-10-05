import "@lock-in/ui/src/global.css";
import "./theme/tokens.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme, readMirror } from "./theme/ThemeProvider";
import { loadBootSnapshot } from "./snapshot";

// Before React mounts: the last-used theme from the localStorage mirror, so
// Login and the verification gate never flash Operator first. ThemeProvider
// owns it from here, and the account's choice overrides on sign-in.
const mirrored = readMirror();
applyTheme(mirrored.theme, mirrored.accent);

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element #root not found");
}

// The last known good state of the signed-in operator, off disk, before the
// first render — so the dashboard can paint real data on frame one instead of
// waiting on a Firebase that may be 24 s away, or unreachable entirely. One
// local file read; it resolves in single-digit milliseconds, and a failure
// just means no snapshot and the old boot path.
await loadBootSnapshot();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
