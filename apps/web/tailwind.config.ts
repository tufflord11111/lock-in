import type { Config } from "tailwindcss";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const uiPreset = require("@lock-in/ui/tailwind.preset.js");

export default {
  presets: [uiPreset],
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
} satisfies Config;
