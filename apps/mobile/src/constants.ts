/**
 * Default website blocklist. Copy of WEB_BLOCKLIST in apps/web/src/App.tsx —
 * it must stay identical so a phone-started session writes the SAME
 * sessionState.blockedUrls shape the desktop writes: these eight domains
 * followed by the user's exe names. The extension reads that field; the
 * desktop enforcer does not (it uses its own local exe list).
 */
export const WEB_BLOCKLIST = [
  "youtube.com", "tiktok.com", "netflix.com",
  "facebook.com", "instagram.com", "twitter.com",
  "reddit.com", "twitch.tv",
];

/** Duration presets, matching the desktop Dashboard. */
export const DURATIONS: { minutes: number; label: string }[] = [
  { minutes: 25, label: "Sprint" },
  { minutes: 45, label: "Focus" },
  { minutes: 60, label: "Deep" },
  { minutes: 90, label: "Lock" },
];
