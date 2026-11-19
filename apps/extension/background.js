import { initializeApp } from "firebase/app";
import { getDatabase, ref, onValue, update, set, forceWebSockets } from "firebase/database";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth/web-extension";
import { buildRules, sameRules } from "./dnrRules.js";
import { withMirrors, archivePattern } from "./mirrors.js";
import MIRRORS from "./mirrors.json";
import { browserFromBrands, BEAT_URL, beatBody, WINDOW_TYPES } from "./beat.js";
import { isLocked, signOutClears } from "./lockState.js";
import { nextHold, holdUntil, nextDesktopHold, laterHoldUntil } from "./sessionHold.js";
import { sessionSiteList, permanentSiteList, freezeSessionSites, effectiveSites } from "./sessionSites.js";

// ─── Firebase Config ──────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyAmN21K_oWOUX2XZKkYJEFsDs1pmb7o17k",
  authDomain: "synchrofocus-ac0f2.firebaseapp.com",
  databaseURL: "https://synchrofocus-ac0f2-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "synchrofocus-ac0f2",
  storageBucket: "synchrofocus-ac0f2.firebasestorage.app",
  messagingSenderId: "987876678302",
  appId: "1:987876678302:web:ecb82346b89f6e5f12798f",
};

const app = initializeApp(firebaseConfig);
// An MV3 service worker has no DOM, so Firebase's long-polling transport —
// which works by injecting <script> tags — can never run here. Force the
// WebSocket transport explicitly. This is the real API; a `forceWebSockets`
// key inside the config object is not a FirebaseOptions field and does nothing.
forceWebSockets();
const db = getDatabase(app);
const auth = getAuth(app);

// A null user is not a sign-out. Auth can report none while the worker wakes or
// offline, and wiping on that dropped every block mid-session. It only stops the
// listening. Blocks are cleared by an explicit sign-out (the popup's SIGNED_OUT),
// a deleted account, or a different account signing in.
onAuthStateChanged(auth, (user) => {
  hydrating.then(() => {
    if (user) {
      startLockInSession(user.uid);
    } else {
      console.log('[Lock-In] No auth session — keeping the saved blocks');
      detachFirebase();
    }
  });
});

const BLOCKED_DOMAINS = [
  'tiktok.com', 'youtube.com', 'netflix.com',
  'instagram.com', 'facebook.com', 'twitter.com',
  'crazygames.com', 'reddit.com', 'twitch.tv',
  'x.com', 'pinterest.com', 'snapchat.com'
];

const STATIC_BLACKLIST = ["youtube.com", "tiktok.com", "netflix.com", "facebook.com", "instagram.com"];

// ─── State ────────────────────────────────────────────────────────────────────
let activeUid = null;
// The lock decision is recomputed at the moment it is needed (isLockedNow),
// from these inputs, never stored as a boolean. A stored boolean was computed
// only when the users/{uid} snapshot changed — and nothing changes when a
// session's endTime passes, so a session whose end never reached Firebase
// (offline, app closed) kept the extension blocking indefinitely (U6).
let manualLock = false;
let focusActive = false;
// sessionState.endTime (epoch ms) of the current session, or null if none.
let sessionEndTime = null;
// emergencyUnlock.expiry (epoch ms), or null.
let unlockExpiry = null;
// A guarded (1.3.1) session seen earlier: blocks until it ends, whatever the
// flags say later (sessionHold.js). { endTime, bailoutEnd, seenNoFuseAt } or null.
let sessionHold = null;
// The desktop app's own session, from its reply to a beat (1.3.1): blocks
// until it ends even if Firebase never says so. Same shape as sessionHold.
let desktopHold = null;
/** When the later of the two holds lifts, or null. */
function heldUntil() {
  return laterHoldUntil(sessionHold, desktopHold);
}
let activeDynamicBlacklist = [...STATIC_BLACKLIST];
// The running session's lists as they were at its start plus anything added,
// { endTime, sites, permanent }, or null. Removals wait for the session's end.
let frozenSession = null;
// A sign-out arrived while a session was locked: the blocks stay until it ends,
// then they are cleared as the sign-out asked (L5).
let signOutPending = false;
/**
 * MV3 evicts this worker after ~30 s idle and every variable here resets. The
 * blocklists only ever came from a Firebase snapshot, so after an eviction
 * with no reachable Firebase — a blocked network, a plane, China — the
 * extension woke up with the five hardcoded defaults and nothing else:
 * session blocking off, permanent blocks gone. Each snapshot is therefore
 * mirrored into chrome.storage.local, and the worker hydrates from it before
 * the first navigation is judged.
 */
const PERSIST_KEY = "lockin_guard_state";
/** Resolves once the worker has read its last known state back. */
let hydrated = false;
const hydrating = (async () => {
  try {
    const stored = await chrome.storage.local.get(PERSIST_KEY);
    const g = stored?.[PERSIST_KEY];
    if (g && typeof g === "object") {
      if (Array.isArray(g.activeDynamicBlacklist)) activeDynamicBlacklist = g.activeDynamicBlacklist;
      if (Array.isArray(g.permanentBlocklist)) permanentBlocklist = g.permanentBlocklist;
      if (typeof g.focusActive === "boolean") focusActive = g.focusActive;
      if (typeof g.sessionEndTime === "number" || g.sessionEndTime === null) sessionEndTime = g.sessionEndTime;
      if (typeof g.manualLock === "boolean") manualLock = g.manualLock;
      if (typeof g.unlockExpiry === "number" || g.unlockExpiry === null) unlockExpiry = g.unlockExpiry;
      if (typeof g.uid === "string") storedUid = g.uid;
      if (g.frozenSession && typeof g.frozenSession.endTime === "number"
          && Array.isArray(g.frozenSession.sites) && Array.isArray(g.frozenSession.permanent)) {
        frozenSession = g.frozenSession;
      }
      if (g.signOutPending === true) signOutPending = true;
      if (holdUntil(g.sessionHold) !== null) sessionHold = g.sessionHold;
      if (holdUntil(g.desktopHold) !== null) desktopHold = g.desktopHold;
      console.log("[Lock-In] hydrated guard state from storage", {
        sites: activeDynamicBlacklist.length,
        permanent: permanentBlocklist.length,
        focusActive,
      });
    }
  } catch (err) {
    console.warn("[Lock-In] guard hydrate failed:", err);
  } finally {
    hydrated = true;
    updateBadge();
    applyRules();
  }
})();

/** The uid the stored state belongs to, so a different sign-in cannot inherit it. */
let storedUid = null;

function persistGuardState() {
  const payload = {
    uid: activeUid || storedUid || null,
    activeDynamicBlacklist,
    permanentBlocklist,
    focusActive,
    sessionEndTime,
    manualLock,
    unlockExpiry,
    frozenSession,
    signOutPending,
    sessionHold,
    desktopHold,
    // The popup decides from this copy too (isLocked reads holdUntil).
    holdUntil: heldUntil(),
    savedAt: Date.now(),
  };
  chrome.storage.local.set({ [PERSIST_KEY]: payload }).catch((err) =>
    console.warn("[Lock-In] guard persist failed:", err)
  );
}
let permanentBlocklist = [];
let userUnsub = null;
let heartbeatInterval = null;
// True only once a server snapshot has shown users/{uid}/config. Nothing is
// written under the user's node until then: a heartbeat sent before that
// check recreated users/{uid} after Delete Account removed it.
let profileConfirmed = false;
let checkingProfile = false;

// Auth errors that mean the account itself is gone or unusable, as opposed to
// a transient failure (offline, rate-limited) that must NOT sign anyone out.
const ACCOUNT_GONE_CODES = new Set([
  "auth/user-not-found",
  "auth/user-disabled",
  "auth/user-token-expired",
  "auth/invalid-user-token",
]);

// ─── Session Management ───────────────────────────────────────────────────────
function startLockInSession(uid) {
  if (activeUid === uid) return;

  detachFirebase();
  // Another account's blocks must not carry over to this one.
  // A guarded session's blocks stay until it ends, even across a switch to
  // another account (B2): only its hold and its frozen lists carry over.
  if (storedUid && storedUid !== uid) {
    const held = holdUntil(sessionHold) !== null && Date.now() < holdUntil(sessionHold) ? sessionHold : null;
    const frozen = held ? frozenSession : null;
    stopLockInSession();
    if (held) {
      sessionHold = held;
      frozenSession = frozen;
      persistGuardState();
      updateBadge();
      applyRules();
    }
  }
  activeUid = uid;

  // 1. Firebase Listener: users/{id} (full lock state + session blocklist)
  //    global_session/state was a single node shared by every user — the last
  //    person to start a session set everyone's blocklist — and is now locked
  //    in the rules. The session blocklist comes from this user's own
  //    sessionState, which arrives in this same snapshot.
  const userRef = ref(db, `users/${activeUid}`);
  userUnsub = onValue(userRef, (snapshot) => {
    const data = snapshot.val();

    // No profile: the account was deleted, or it was never provisioned.
    // Find out which before doing anything, and write nothing meanwhile.
    if (!data?.config) {
      handleMissingProfile(uid);
      return;
    }

    // Profile confirmed by the server — only now start writing heartbeats.
    if (!profileConfirmed) {
      profileConfirmed = true;
      pulseHeartbeat();
      heartbeatInterval = setInterval(pulseHeartbeat, 30000);
    }

    unlockExpiry =
      typeof data.emergencyUnlock?.expiry === "number" ? data.emergencyUnlock.expiry : null;
    manualLock = data.isLocked === true;
    focusActive = data.config?.focusActive === true;
    sessionEndTime =
      typeof data.sessionState?.endTime === "number" ? data.sessionState.endTime : null;
    sessionHold = nextHold(sessionHold, data, Date.now());

    // DEFAULT_BLOCKS + customBlocks - removedDefaults, plus the session's own
    // blockedUrls, and while a session runs, everything it started with
    // (sessionSites.js has the rules and their tests).
    activeDynamicBlacklist = sessionSiteList(BLOCKED_DOMAINS, data);
    permanentBlocklist = permanentSiteList(data);
    frozenSession = freezeSessionSites(
      frozenSession,
      { sites: activeDynamicBlacklist, permanent: permanentBlocklist },
      heldSession(),
      Date.now()
    );

    // Mirror to disk so an eviction does not lose it.
    storedUid = activeUid;
    persistGuardState();
    applyRules();

    console.log(
      "[Lock-In] Session state -> locked:", isLockedNow(),
      "| session ends:", sessionEndTime ? new Date(sessionEndTime).toISOString() : "none",
      "| blocks:", activeDynamicBlacklist.length
    );
    console.log("[Blocker] Full active list:", activeDynamicBlacklist);
    updateBadge();
  });
}

// Called when users/{uid} has no config. Distinguishes a deleted account from
// one that simply has no profile yet by forcing a token refresh: Firebase does
// not push server-side deletions to signed-in clients, so without this the
// extension stays signed in until its ID token lapses (up to an hour).
async function handleMissingProfile(uid) {
  if (checkingProfile) return;
  checkingProfile = true;
  try {
    // Stop writing immediately either way.
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    profileConfirmed = false;

    const user = auth.currentUser;
    if (!user || user.uid !== uid || activeUid !== uid) return;

    try {
      await user.getIdToken(true);
    } catch (err) {
      if (ACCOUNT_GONE_CODES.has(err?.code)) {
        console.warn("[Lock-In] Account no longer exists — signing out:", err.code);
        stopLockInSession();
        await signOut(auth).catch(() => {});
      } else {
        console.warn("[Lock-In] Profile missing; token check inconclusive:", err?.code ?? err);
      }
      return;
    }
    // Token refreshed: the account exists but has no profile. Stay signed in,
    // write nothing; the listener starts heartbeats once config appears.
    console.log("[Lock-In] Signed in, but no profile yet — holding writes.");
  } finally {
    checkingProfile = false;
  }
}

/** Stop listening and beating. Everything being enforced stays as it is. */
function detachFirebase() {
  if (userUnsub) userUnsub();
  if (heartbeatInterval) clearInterval(heartbeatInterval);

  userUnsub = null;
  heartbeatInterval = null;
  profileConfirmed = false;
  activeUid = null;
}

/** Forget this account's blocks entirely. Resolves once the rules are gone. */
function stopLockInSession() {
  console.log("[Lock-In] Securing vault. Session stopped.");
  detachFirebase();
  manualLock = false;
  focusActive = false;
  sessionEndTime = null;
  unlockExpiry = null;
  activeDynamicBlacklist = [...STATIC_BLACKLIST];
  permanentBlocklist = [];
  frozenSession = null;
  signOutPending = false;
  sessionHold = null;
  storedUid = null;
  // This PC's own session isn't the account's to clear: it holds until it ends.
  if (holdUntil(desktopHold) === null || Date.now() >= holdUntil(desktopHold)) desktopHold = null;
  if (desktopHold) persistGuardState();
  else chrome.storage.local.remove(PERSIST_KEY).catch(() => {});
  updateBadge();
  return applyRules();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function lockInputs() {
  return { manualLock, focusActive, sessionEndTime, unlockExpiry, holdUntil: heldUntil() };
}

/** The session the lists are frozen for: the held one while it lasts, else the flags. */
function heldSession() {
  const until = heldUntil();
  if (until !== null && Date.now() < until) {
    const end = focusActive && typeof sessionEndTime === "number" ? Math.max(until, sessionEndTime) : until;
    return { focusActive: true, endTime: end };
  }
  return { focusActive, endTime: sessionEndTime };
}

/** The lists to enforce right now, with whatever the running session holds. */
function enforcedLists() {
  return effectiveSites(
    { sites: activeDynamicBlacklist, permanent: permanentBlocklist },
    frozenSession,
    Date.now()
  );
}

function isLockedNow() {
  return isLocked(lockInputs(), Date.now());
}

function pulseHeartbeat() {
  if (!activeUid || !profileConfirmed) return;
  const extensionStateRef = ref(db, `users/${activeUid}/extension_state`);
  update(extensionStateRef, {
    last_seen: Date.now(),
    version: chrome.runtime.getManifest().version,
    status: "online"
  }).catch(err => console.error("[Heartbeat Error]:", err));
}

// Tell the desktop app on this PC we're here and which browser this is. Local
// only, so it works offline. No app listening just means this fails quietly.
// Signed out there's no uid, which tells the app this copy isn't enforcing.
async function beatToDesktop() {
  await hydrating;
  const uid = activeUid || storedUid || null;
  const incognitoAllowed = await chrome.extension.isAllowedIncognitoAccess();
  const browser = browserFromBrands(navigator.userAgentData?.brands, typeof navigator.brave !== "undefined");
  // The app checks this count against the windows Windows shows for this
  // browser: one Web Guard can't see is a Guest window, another profile, or
  // Incognito without access.
  const windows = await chrome.windows.getAll({ windowTypes: WINDOW_TYPES }).then((w) => w.length, () => null);
  // Site access cut to "on click" or a few sites in the browser's settings
  // means some sites can't be blocked: the app treats that as no Web Guard.
  const hostAccess = await chrome.permissions.contains({ origins: ["<all_urls>"] }).catch(() => false);
  let reply = null;
  try {
    const res = await fetch(BEAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(beatBody({
        browser,
        version: chrome.runtime.getManifest().version,
        incognitoAllowed,
        uid,
        profileId: await profileId(),
        windows,
        locked: isLockedNow(),
        hostAccess,
      })),
    });
    if (res.status === 200) reply = await res.json().catch(() => null);
  } catch {
    return; // no app on this PC, or it isn't listening
  }
  // The app's own session: block for it even if Firebase never says so.
  const wasLocked = isLockedNow();
  desktopHold = nextDesktopHold(desktopHold, reply, Date.now());
  persistGuardState();
  if (isLockedNow() !== wasLocked) {
    console.log("[Lock-In] the desktop app says a session is running — blocking");
    updateBadge();
    await applyRules();
    // Tell the app at once that it's blocking now.
    beatShortly();
  }
}

// A random id for this profile, kept in its own storage, so the app can tell
// two profiles of one browser apart. Not tied to the account or the PC.
const PROFILE_KEY = "lockin_profile_id";
let profileIdRead = null;
function profileId() {
  if (!profileIdRead) {
    profileIdRead = (async () => {
      const got = await chrome.storage.local.get(PROFILE_KEY);
      let id = got?.[PROFILE_KEY];
      if (typeof id !== "string" || !id) {
        id = crypto.randomUUID();
        await chrome.storage.local.set({ [PROFILE_KEY]: id });
      }
      return id;
    })().catch(() => null);
  }
  return profileIdRead;
}

// A new window is counted at once, so the app doesn't take it for one Web
// Guard can't see. Bursts (a session restore) send one beat.
let beatSoon = null;
function beatShortly() {
  clearTimeout(beatSoon);
  beatSoon = setTimeout(beatToDesktop, 300);
}
chrome.windows.onCreated.addListener(beatShortly);
// The app counts a beat older than 35 s as gone. The keepAlive alarm (about
// every 30 s) wakes the worker; while it is awake it also beats every 15 s.
setInterval(beatToDesktop, 15_000);
chrome.windows.onRemoved.addListener(beatShortly);

// Open-tab upload (F5) has been removed entirely: nothing enumerates tabs or
// writes users/{uid}/openTabs, the desktop no longer asks for it, and the
// rules reject any openTabs write from older builds.

function getBlockUrl() {
  return chrome.runtime.getURL("block.html");
}

// [•] toolbar icon: red dot while locked, grey dot (the manifest default) idle.
const ICON_LOCKED = { 16: "icon16.png", 32: "icon32.png", 48: "icon48.png", 128: "icon128.png" };
const ICON_IDLE = { 16: "icon16-idle.png", 32: "icon32-idle.png", 48: "icon48-idle.png", 128: "icon128-idle.png" };

function updateBadge() {
  const locked = isLockedNow();
  chrome.action.setBadgeText({ text: locked ? "LOCK" : "" });
  chrome.action.setBadgeBackgroundColor({ color: locked ? "#FF0000" : "#002855" });
  chrome.action.setIcon({ path: locked ? ICON_LOCKED : ICON_IDLE }).catch(() => {});
}

// ─── Blocking Rules ───────────────────────────────────────────────────────────
// Dynamic rules block before the request leaves, and survive worker eviction and
// browser restarts. The decision comes from isLockedNow(), never from which
// alarm fired, so a late alarm only delays removal until the next keepAlive.
function armExpiryAlarm(name, when) {
  if (typeof when === "number" && when > Date.now()) {
    chrome.alarms.create(name, { when });
  } else {
    chrome.alarms.clear(name);
  }
}

async function reconcileRules() {
  await hydrating;
  const lists = enforcedLists();
  // Each blocked site with its mirrors (mirrors.json): youtube-nocookie.com
  // and Invidious for YouTube, any site through translate.goog, and its pages
  // inside web.archive.org.
  // updateDynamicRules rejects the whole call on one bad rule, so an archive
  // pattern Chrome won't take (a very long list) is left out, never sent.
  const usable = async (pattern) => {
    if (!pattern) return null;
    const ok = await chrome.declarativeNetRequest.isRegexSupported({ regex: pattern, isCaseSensitive: false })
      .then((r) => r?.isSupported === true, () => false);
    if (!ok) console.warn("[Lock-In] archive pattern too large; archive pages not covered this time");
    return ok ? pattern : null;
  };
  const wanted = buildRules({
    locked: isLockedNow(),
    sessionSites: withMirrors(lists.sites, MIRRORS),
    permanentSites: withMirrors(lists.permanent, MIRRORS),
    sessionArchive: await usable(archivePattern(lists.sites, MIRRORS)),
    permanentArchive: await usable(archivePattern(lists.permanent, MIRRORS)),
  });
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  if (!sameRules(existing, wanted)) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((r) => r.id),
      addRules: wanted,
    });
    console.log("[Lock-In] blocking rules now:", wanted.map((r) => r.id));
  }
  const session = heldSession();
  armExpiryAlarm("sessionEnd", session.focusActive ? session.endTime : null);
  armExpiryAlarm("unlockEnd", unlockExpiry);
}

// One at a time: overlapping updates would fight over the same rule ids.
let rulesQueue = Promise.resolve();
function applyRules() {
  rulesQueue = rulesQueue
    .then(reconcileRules)
    .catch((err) => console.error("[Lock-In] rule update failed:", err));
  return rulesQueue;
}

chrome.runtime.onStartup.addListener(() => {
  applyRules();
  beatToDesktop();
  // Chrome resets the action icon to the manifest's idle set here; put the
  // real state back once the stored state is read.
  hydrating.then(updateBadge);
});
chrome.runtime.onInstalled.addListener(() => {
  applyRules();
  beatToDesktop();
  // Chrome resets the action icon to the manifest's idle set here; put the
  // real state back once the stored state is read.
  hydrating.then(updateBadge);
});

/** The same decision as the rules: a site, one of its mirrors, or its archived pages. */
function isBlockedWithMirrors(url, sites) {
  if (isDomainBlocked(url, withMirrors(sites, MIRRORS))) return true;
  const pattern = archivePattern(sites, MIRRORS);
  try {
    return pattern !== null && new RegExp(pattern, "i").test(url);
  } catch {
    return false;
  }
}

function isDomainBlocked(url, blockList) {
  try {
    const hostname = new URL(url).hostname
      .replace(/^www\./, '')
      .toLowerCase();
    
    // Check if hostname matches any blocked domain
    // This handles both exact matches AND subdomains
    return blockList.some(blocked => {
      const cleanBlocked = blocked
        .replace(/^www\./, '')
        .toLowerCase();
      
      // Exact match: notion.so === notion.so
      // Subdomain match: sub.notion.so contains notion.so
      return hostname === cleanBlocked || 
             hostname.endsWith('.' + cleanBlocked);
    });
  } catch {
    return false;
  }
}

// ─── Navigation Interceptors ──────────────────────────────────────────────────
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  // A freshly woken worker must not wave a blocked site through while it is
  // still reading its own state back; the read is local and sub-millisecond.
  if (!hydrated) {
    hydrating.then(() => guardNavigation(details.tabId, details.url));
    return;
  }
  guardNavigation(details.tabId, details.url);
});

/** One place that decides whether a URL is allowed, used by both listeners. */
function guardNavigation(tabId, url) {
  if (!url) return;
  try {
    const lists = enforcedLists();
    // Always block permanent sites
    if (isBlockedWithMirrors(url, lists.permanent)) {
      chrome.tabs.update(tabId, { url: getBlockUrl() });
      return;
    }
    // Block session sites only when locked
    if (isLockedNow() && isBlockedWithMirrors(url, lists.sites)) {
      chrome.tabs.update(tabId, { url: getBlockUrl() });
    }
  } catch (_) {}
}

// Same outcome as the rules: the block page. This used to close the tab, which
// would now also race the redirect and close a tab on its way to block.html.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const currentUrl = changeInfo.url || tab.url;
  if (!currentUrl) return;
  hydrating.then(() => guardNavigation(tabId, currentUrl));
});

// ─── Keep-Alive Alarm ─────────────────────────────────────────────────────────
chrome.alarms.create("keepAlive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  // The badge and rules otherwise change only on a snapshot, and endTime passing
  // produces none. sessionEnd/unlockEnd land on time; keepAlive (about every
  // 30 s) is the backstop for a missed one.
  hydrating.then(() => {
    // A sign-out made during the session clears once the session is over and
    // nobody has signed back in.
    if (signOutPending && !activeUid && signOutClears(lockInputs(), Date.now())) {
      console.log("[Lock-In] session over — applying the sign-out made during it");
      stopLockInSession();
      return;
    }
    updateBadge();
    applyRules();
  });
  if (alarm.name === "keepAlive") beatToDesktop();
  if (alarm.name === "keepAlive" && activeUid) {
    // Keep-alive read against this user's own node — global_session is locked
    // in the rules and would return permission_denied.
    const pingRef = ref(db, `users/${activeUid}/extension_state`);
    onValue(pingRef, () => {}, { onlyOnce: true });

    // Write only once the profile is confirmed, same gate as pulseHeartbeat.
    if (profileConfirmed) {
      const heartbeatRef = ref(db, `users/${activeUid}/extension_state/last_seen`);
      set(heartbeatRef, Date.now()).catch(() => {});
    }
    console.log("[Lock-In] Keep-alive ping for:", activeUid);
  }
});

// ─── Message Handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "checkStatus") {
    hydrating.then(() => sendResponse({ isLocked: isLockedNow(), blocklist: enforcedLists().sites }));
    return true;
  } else if (request.action === "SIGNED_OUT") {
    // Sent by the popup before it signs out: the one user-made clear. While a
    // session is locked it waits for the session's end (L5).
    hydrating.then(() => {
      if (signOutClears(lockInputs(), Date.now())) {
        stopLockInSession().then(() => sendResponse({ status: "cleared" }));
      } else {
        signOutPending = true;
        persistGuardState();
        console.log("[Lock-In] sign-out during a session: blocks stay until it ends");
        sendResponse({ status: "kept-until-session-ends" });
      }
    });
    return true;
  } else if (request.type === "GET_TIMER_STATE") {
    chrome.storage.local.get(["timeLeft", "focusActive"], (res) => {
      sendResponse({ timeLeft: res.timeLeft, focusActive: res.focusActive });
    });
    return true;
  }
});
