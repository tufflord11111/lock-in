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

// The overlay has its own page; the app never mounts in its window.
if (window.location.pathname.endsWith("parrot.html")) {
  throw new Error("The app loaded in the parrot page");
}

// A hidden window still reports itself visible, so CSS animations keep drawing. The
// session label's pulse alone cost 1.3% of total CPU in the GPU process with main in
// the tray. They pause whenever this window doesn't have the focus.
const noteFocus = () => document.documentElement.toggleAttribute("data-unfocused", !document.hasFocus());
window.addEventListener("focus", noteFocus);
window.addEventListener("blur", noteFocus);
noteFocus();

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element #root not found");
}

// The last known good state of the signed-in operator, off disk, before the
// first render — so the dashboard can paint real data on frame one instead of
// waiting on a Firebase that may be 24 s away, or unreachable entirely. One
// local file read; it resolves in single-digit milliseconds, and a failure
// just means no snapshot and the old boot path.
try {
  await loadBootSnapshot();

  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} finally {
  // The [•] loader in index.html stays up until here: the boot is done (or
  // failed) and React has its first render queued. index.html also finishes
  // it on any uncaught error, so it can never outlast the boot.
  (window as Window & { lockInLoaderFinish?: () => void }).lockInLoaderFinish?.();
}
