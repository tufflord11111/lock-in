import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// packages/firebase hardcodes its config, so no env plumbing is needed here.
export default defineConfig({
  plugins: [react()],
  server: { host: true },
});
