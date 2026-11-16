// The session's site list, from the users/{uid} snapshot. Pure, so it is tested
// without a browser (sessionSites.test.mjs).

function values(node) {
  if (Array.isArray(node)) return node;
  return node && typeof node === "object" ? Object.values(node) : [];
}

/**
 * DEFAULT_BLOCKS + customBlocks - removedDefaults, unioned with the session's
 * own blockedUrls (written by the desktop at session start). The blockedUrls
 * are NOT filtered by removedDefaults (1.3.1 H1): they are what the session
 * started with, already without the defaults removed before it, so a default
 * removed during the session stays blocked until it ends.
 */
export function sessionSiteList(defaults, data) {
  const removedDefaults = values(data?.removedDefaults);
  const customBlocks = values(data?.customBlocks).filter((v) => typeof v === "string");
  const activeDefaults = defaults.filter((d) => !removedDefaults.includes(d));
  const sessionBlockedUrls = Array.isArray(data?.sessionState?.blockedUrls)
    ? data.sessionState.blockedUrls.filter((u) => typeof u === "string")
    : [];
  return [...new Set([...activeDefaults, ...customBlocks, ...sessionBlockedUrls])];
}

/** The permanent site list from the snapshot. */
export function permanentSiteList(data) {
  return values(data?.permanentBlocks).filter((v) => typeof v === "string");
}

const union = (a, b) => [...new Set([...a, ...b])];

/**
 * What a running session holds on to: { endTime, sites, permanent } or null.
 * While the session is live (focusActive, before its endTime) the hold only
 * grows: it starts as the lists at the first snapshot of the session and takes
 * in every addition. A different endTime is a different session, and starts a
 * new hold. Ends with the session (its endTime, or focusActive going false:
 * Bail out's fuse burning down, or the session finishing).
 */
export function freezeSessionSites(prev, current, session, now) {
  const end = session?.endTime;
  if (session?.focusActive !== true || typeof end !== "number" || now >= end) return null;
  if (prev && prev.endTime === end) {
    return {
      endTime: end,
      sites: union(prev.sites, current.sites),
      permanent: union(prev.permanent, current.permanent),
    };
  }
  return { endTime: end, sites: [...current.sites], permanent: [...current.permanent] };
}

/** The lists to enforce now: the current ones, plus whatever the session holds. */
export function effectiveSites(current, frozen, now) {
  if (!frozen || now >= frozen.endTime) {
    return { sites: current.sites, permanent: current.permanent };
  }
  return {
    sites: union(current.sites, frozen.sites),
    permanent: union(current.permanent, frozen.permanent),
  };
}
