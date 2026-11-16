import { sanitizeSite } from "../hooks/useSessionSites";

/**
 * Blocks removed during a running session still apply until it ends (1.3.1 H1).
 * The Blocks tab lists them, so a removal is never a silent no-op.
 */

/** The badge on a held block, and the toast when one is removed mid-session. */
export const HELD_LABEL = "Removes after this session";
export const heldToast = (name: string) => `${name} stays blocked until this session ends, then it's removed.`;

/**
 * Sites the running session still blocks that are no longer in the lists:
 * its blockedUrls at start, less what the Blocks tab shows now. Sorted.
 */
export function heldSites(sessionBlockedUrls: unknown, listedSites: string[]): string[] {
  if (!Array.isArray(sessionBlockedUrls)) return [];
  const listed = new Set(listedSites.map(sanitizeSite));
  const held = sessionBlockedUrls
    .map(sanitizeSite)
    .filter((s): s is string => s !== null && !listed.has(s));
  return [...new Set(held)].sort();
}
