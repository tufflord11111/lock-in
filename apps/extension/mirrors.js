// Mirrors of a blocked site: other domains that serve the same thing. The list
// itself is data (mirrors.json); this only applies it. No chrome.* here, so it
// can be tested.

import { sanitizeDomain } from "./dnrRules.js";

/** Google Translate's proxy host for a site: youtube.com -> youtube-com.translate.goog. */
export function translateHost(domain) {
  return `${domain.replace(/-/g, "--").replace(/\./g, "-")}.translate.goog`;
}

/**
 * The blocked sites plus their mirrors, as domains. A blocked subdomain
 * (m.youtube.com) brings its parent's mirrors too only if the parent is listed;
 * mirrors are looked up by the exact blocked domain and by every parent of it.
 */
export function withMirrors(sites, mirrors) {
  const out = new Set();
  for (const raw of sites ?? []) {
    const d = sanitizeDomain(raw);
    if (!d) continue;
    out.add(d);
    const parts = d.split(".");
    for (let i = 0; i < parts.length - 1; i++) {
      const parent = parts.slice(i).join(".");
      for (const m of mirrors?.bySite?.[parent] ?? []) {
        const md = sanitizeDomain(m);
        if (md) out.add(md);
      }
    }
    if (mirrors?.translateGoog) {
      const t = translateHost(d);
      out.add(t);
      out.add(`www-${t}`);
      out.add(`m-${t}`);
    }
  }
  return [...out].sort();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One RE2 pattern matching a blocked site's pages inside an archive
 * (https://web.archive.org/web/20240101000000/https://www.youtube.com/...),
 * or null when there are no sites or no archives.
 */
export function archivePattern(sites, mirrors) {
  const archives = (mirrors?.archives ?? []).map(sanitizeDomain).filter(Boolean);
  const domains = [...new Set((sites ?? []).map(sanitizeDomain).filter(Boolean))].sort();
  if (archives.length === 0 || domains.length === 0) return null;
  return (
    `^https?://(${archives.map(escapeRe).join("|")})/web/[^/]*/` +
    `(https?(://|%3A%2F%2F))?([a-z0-9-]+\\.)*(${domains.map(escapeRe).join("|")})([/:?#%]|$)`
  );
}
