/**
 * The iframe src for a saved Google Calendar link, or null if it isn't a Public
 * embed URL. Used at save AND at render: malformed values are already stored in
 * existing accounts, and render must not trust storage.
 *
 * Parsed, not prefix-tested: https://calendar.google.com.evil.com passes a
 * startsWith. A raw # in the id would silently truncate it to the wrong
 * calendar, so a hash is rejected. Setting the view with URLSearchParams keeps
 * the ?/& join right and can't duplicate a pasted mode=.
 */
export function buildCalendarSrc(saved: unknown): string | null {
  if (typeof saved !== "string") return null;
  let url: URL;
  try {
    url = new URL(saved.trim());
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "calendar.google.com" ||
    url.pathname !== "/calendar/embed" ||
    !url.searchParams.get("src") ||
    url.hash
  ) {
    return null;
  }
  const view = {
    mode: "WEEK",
    showTitle: "0",
    showNav: "1",
    showDate: "1",
    showPrint: "0",
    showTabs: "0",
    showCalendars: "0",
  };
  for (const [key, value] of Object.entries(view)) url.searchParams.set(key, value);
  return url.toString();
}
