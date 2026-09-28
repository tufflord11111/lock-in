import "@lock-in/ui/src/global.css";
import "./theme/tokens.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme, readMirror } from "./theme/ThemeProvider";

// Before React mounts: the last-used theme from the localStorage mirror, so
// Login and the verification gate never flash Operator first. ThemeProvider
// owns it from here, and the account's choice overrides on sign-in.
const mirrored = readMirror();
applyTheme(mirrored.theme, mirrored.accent);

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element #root not found");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
