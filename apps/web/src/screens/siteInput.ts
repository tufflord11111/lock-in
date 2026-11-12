/**
 * What someone types into "block a site", turned into the site to block, for
 * people who don't know what a domain is: "youtube", "YouTube.com",
 * "https://www.youtube.com/watch?v=x" and "www.youtube.com/" all mean
 * youtube.com. A bare word with no dot gets ".com". Only real garbage is
 * refused, with a plain reason and an example.
 */
export type SiteInput =
  | { ok: true; domain: string }
  | { ok: false; reason: "empty" | "app" | "garbage" };

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeSite(raw: string): SiteInput {
  let s = raw.trim().toLowerCase();
  if (!s) return { ok: false, reason: "empty" };
  // A program, not a site.
  if (/\.(exe|lnk|msi|bat|cmd)$/.test(s)) return { ok: false, reason: "app" };
  s = s
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "") // https://, http://, chrome-extension:// …
    .replace(/[/?#].*$/, "") // the page, query and fragment
    .replace(/^[^@]*@/, "") // user:pass@
    .replace(/:\d+$/, "") // a port
    .replace(/^www\d*\./, "")
    .replace(/\.+$/, ""); // a trailing dot
  if (!s) return { ok: false, reason: "garbage" };
  // A bare word is that word's .com: "youtube" -> youtube.com.
  if (!s.includes(".")) s = `${s}.com`;
  const labels = s.split(".");
  const tld = labels[labels.length - 1];
  if (labels.some((l) => !LABEL.test(l))) return { ok: false, reason: "garbage" };
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(tld)) return { ok: false, reason: "garbage" };
  if (s.length > 253) return { ok: false, reason: "garbage" };
  return { ok: true, domain: s };
}
