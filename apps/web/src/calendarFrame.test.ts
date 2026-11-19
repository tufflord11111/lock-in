import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 1.3.1 L9: the Google Calendar embed is sandboxed and sends no referrer. It
// may run its own scripts and open a link in a new window (which the desktop
// app hands to the system browser, lib.rs new_window_request); it may not
// navigate Lock-In's page, submit forms or open dialogs over it.
const page = readFileSync(new URL("./screens/PerformanceLog.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const frame = page.slice(page.indexOf("<iframe"), page.indexOf("/>", page.indexOf("<iframe")));

describe("calendar iframe", () => {
  it("is sandboxed to scripts, its own origin and popups", () => {
    const sandbox = /sandbox="([^"]*)"/.exec(frame)?.[1].split(/\s+/).sort();
    expect(sandbox).toEqual(["allow-popups", "allow-popups-to-escape-sandbox", "allow-same-origin", "allow-scripts"]);
  });
  it("sends no referrer", () => {
    expect(frame).toContain('referrerPolicy="no-referrer"');
  });
});
