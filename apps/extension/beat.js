// The heartbeat to the Lock-In desktop app. No chrome.* here, so it can be tested
// without a browser. The port must match heartbeat.rs.

export const BEAT_URL = "http://127.0.0.1:47823/beat";

/**
 * Which browser this is. Anything it can't name reports "chromium", which the
 * app treats as no heartbeat: being wrongly closed is the safe failure.
 */
export function browserFromBrands(brands, hasBraveApi = false) {
  const names = (brands ?? []).map((b) => b.brand);
  if (hasBraveApi || names.includes("Brave")) return "brave";
  if (names.includes("Microsoft Edge")) return "edge";
  if (names.includes("Google Chrome")) return "chrome";
  return "chromium";
}
