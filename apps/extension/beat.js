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

/** Every kind of window Web Guard can see, so its count is never short of Windows'. */
export const WINDOW_TYPES = ["normal", "popup", "app", "devtools"];

/**
 * The beat's body. profileId tells the app which profile this copy runs in
 * (a random id kept in this profile's storage); windows is how many windows it
 * can see, so the app can tell when the browser shows one it can't: a Guest
 * window, another profile without Web Guard, or Incognito when it isn't allowed.
 */
export function beatBody({ browser, version, incognitoAllowed, uid, profileId, windows }) {
  return {
    browser,
    version,
    incognitoAllowed: incognitoAllowed === true,
    uid: uid ?? null,
    profileId: typeof profileId === "string" ? profileId : null,
    windows: Number.isInteger(windows) && windows >= 0 ? windows : null,
  };
}
