// The declarativeNetRequest rules for a given lock state. No chrome.* here, so
// it can be tested without a browser.

export const SESSION_RULE_ID = 1;
export const PERMANENT_RULE_ID = 1000;

/**
 * "https://www.YouTube.com/x" → "youtube.com". null when it isn't a domain:
 * session lists also carry app names like "discord.exe" and "spotify".
 *
 * Every entry goes through here because updateDynamicRules rejects the WHOLE
 * call on one bad domain, and then nothing is blocked at all.
 */
export function sanitizeDomain(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  let host;
  try {
    // URL also lowercases and punycodes it, which requestDomains requires.
    host = new URL(text.includes("://") ? text : `https://${text}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  if (!host.includes(".") || host.endsWith(".exe")) return null;
  if (!/^[a-z0-9.-]+$/.test(host) || /^[0-9.]+$/.test(host)) return null;
  return host;
}

function redirectRule(id, sites) {
  const domains = [...new Set(sites.map(sanitizeDomain).filter(Boolean))].sort();
  // An empty requestDomains is invalid, and would not mean "nothing" anyway.
  if (domains.length === 0) return null;
  return {
    id,
    priority: 1,
    action: { type: "redirect", redirect: { extensionPath: "/block.html" } },
    // requestDomains also matches subdomains. sub_frame closes the iframe hole.
    condition: { requestDomains: domains, resourceTypes: ["main_frame", "sub_frame"] },
  };
}

export const SESSION_ARCHIVE_RULE_ID = 2;
export const PERMANENT_ARCHIVE_RULE_ID = 1001;

/** A blocked site's pages inside an archive, by URL pattern (mirrors.js archivePattern). */
function archiveRule(id, pattern) {
  if (typeof pattern !== "string" || !pattern) return null;
  return {
    id,
    priority: 1,
    action: { type: "redirect", redirect: { extensionPath: "/block.html" } },
    condition: { regexFilter: pattern, isUrlFilterCaseSensitive: false, resourceTypes: ["main_frame", "sub_frame"] },
  };
}

/**
 * Permanent blocks always apply; session blocks only while locked. The site
 * lists already include their mirrors (mirrors.js withMirrors); the archive
 * patterns are optional.
 */
export function buildRules({ locked, sessionSites, permanentSites, sessionArchive = null, permanentArchive = null }) {
  return [
    locked ? redirectRule(SESSION_RULE_ID, sessionSites) : null,
    locked ? archiveRule(SESSION_ARCHIVE_RULE_ID, sessionArchive) : null,
    redirectRule(PERMANENT_RULE_ID, permanentSites),
    archiveRule(PERMANENT_ARCHIVE_RULE_ID, permanentArchive),
  ].filter(Boolean);
}

/** Same ids blocking the same domains and patterns. The action never varies. */
export function sameRules(existing, wanted) {
  const shape = (rules) =>
    JSON.stringify(
      rules
        .map((r) => [r.id, [...(r.condition?.requestDomains ?? [])].sort(), r.condition?.regexFilter ?? null])
        .sort((a, b) => a[0] - b[0])
    );
  return shape(existing) === shape(wanted);
}
