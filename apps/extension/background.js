import { initializeApp } from "firebase/app";
import { getDatabase, ref, onValue, update, set, forceWebSockets } from "firebase/database";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth/web-extension";

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

onAuthStateChanged(auth, (user) => {
  if (user) {
    startLockInSession(user.uid);
  } else {
    console.log('[Lock-In] No auth session');
    stopLockInSession();
  }
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
let thresholdReached = false;
let focusActive = false;
// sessionState.endTime (epoch ms) of the current session, or null if none.
let sessionEndTime = null;
// emergencyUnlock.expiry (epoch ms), or null.
let unlockExpiry = null;
// Set by the popup's FORCE_UNLOCK; cleared by the next snapshot, the same
// lifetime the previous stored-boolean override had.
let forceUnlocked = false;
let activeDynamicBlacklist = [...STATIC_BLACKLIST];
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

  stopLockInSession();
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

    const thresholdLimit = data.config?.thresholdLimit || 360;
    const devices = data.devices || {};

    let totalMinutesToday = 0;
    Object.values(devices).forEach(device => {
      totalMinutesToday += (device.minutesToday || 0);
    });

    unlockExpiry =
      typeof data.emergencyUnlock?.expiry === "number" ? data.emergencyUnlock.expiry : null;
    manualLock = data.isLocked === true;
    focusActive = data.config?.focusActive === true;
    sessionEndTime =
      typeof data.sessionState?.endTime === "number" ? data.sessionState.endTime : null;
    thresholdReached = totalMinutesToday >= thresholdLimit;
    forceUnlocked = false;

    // Build final dynamic blocklist:
    // DEFAULT_BLOCKS + customBlocks - removedDefaults
    const removedDefaults = data.removedDefaults 
      ? (Array.isArray(data.removedDefaults) ? data.removedDefaults : Object.values(data.removedDefaults))
      : [];

    const customBlocks = data.customBlocks
      ? Object.values(data.customBlocks).map(v => 
          typeof v === 'string' ? v : null
        ).filter(Boolean)
      : [];

    const activeDefaults = BLOCKED_DOMAINS.filter(
      d => !removedDefaults.includes(d)
    );

    // Session blocklist from THIS user's sessionState (written by the desktop
    // on startSession). Unioned, not substituted: masterBlockList carries the
    // desktop defaults + exe names but NOT customBlocks, so preferring it
    // outright would drop the user's custom site blocks mid-session. Filtered
    // by removedDefaults so a removed default is not silently re-added.
    const sessionBlockedUrls = Array.isArray(data.sessionState?.blockedUrls)
      ? data.sessionState.blockedUrls.filter(
          u => typeof u === 'string' && !removedDefaults.includes(u)
        )
      : [];

    activeDynamicBlacklist = [
      ...new Set([...activeDefaults, ...customBlocks, ...sessionBlockedUrls])
    ];

    permanentBlocklist = data.permanentBlocks
      ? Object.values(data.permanentBlocks).filter(v => typeof v === 'string')
      : [];

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

function stopLockInSession() {
  console.log("[Lock-In] Securing vault. Session stopped.");
  if (userUnsub) userUnsub();
  if (heartbeatInterval) clearInterval(heartbeatInterval);

  userUnsub = null;
  heartbeatInterval = null;
  profileConfirmed = false;
  activeUid = null;
  manualLock = false;
  thresholdReached = false;
  focusActive = false;
  sessionEndTime = null;
  unlockExpiry = null;
  forceUnlocked = false;
  activeDynamicBlacklist = [...STATIC_BLACKLIST];
  permanentBlocklist = [];
  updateBadge();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
/**
 * Whether session blocking applies right now.
 *
 * Expiry only cancels the focus-session term: a manual lock and the daily
 * threshold still lock after endTime. A session with no endTime keeps the old
 * behaviour and locks for as long as focusActive is true.
 */
function isLockedNow() {
  if (forceUnlocked) return false;
  const now = Date.now();
  if (unlockExpiry != null && now < unlockExpiry) return false;
  const sessionLive =
    focusActive && (sessionEndTime == null || now < sessionEndTime);
  return manualLock || thresholdReached || sessionLive;
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

// Open-tab upload (F5) has been removed entirely: nothing enumerates tabs or
// writes users/{uid}/openTabs, the desktop no longer asks for it, and the
// rules reject any openTabs write from older builds.

function getBlockUrl() {
  return chrome.runtime.getURL("block.html");
}

function updateBadge() {
  const locked = isLockedNow();
  chrome.action.setBadgeText({ text: locked ? "LOCK" : "" });
  chrome.action.setBadgeBackgroundColor({ color: locked ? "#FF0000" : "#002855" });
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
  try {
    // Always block permanent sites
    if (isDomainBlocked(details.url, permanentBlocklist)) {
      chrome.tabs.update(details.tabId, { url: getBlockUrl() });
      return;
    }
    // Block session sites only when locked
    if (isLockedNow() && isDomainBlocked(details.url, activeDynamicBlacklist)) {
      chrome.tabs.update(details.tabId, { url: getBlockUrl() });
    }
  } catch (_) {}
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const currentUrl = changeInfo.url || tab.url;
  if (!currentUrl) return;
  try {
    // Always block permanent sites
    if (isDomainBlocked(currentUrl, permanentBlocklist)) {
      const urlObj = new URL(currentUrl);
      console.log(`[Lock-In] PERMANENT BLOCK: ${urlObj.hostname}`);
      chrome.tabs.remove(tabId);
      return;
    }
    // Block session sites only when locked
    if (isLockedNow() && isDomainBlocked(currentUrl, activeDynamicBlacklist)) {
      const urlObj = new URL(currentUrl);
      console.log(`[Lock-In] THREAT BLOCKED: ${urlObj.hostname}`);
      chrome.tabs.remove(tabId);
    }
  } catch (e) {}
});

// ─── Keep-Alive Alarm ─────────────────────────────────────────────────────────
chrome.alarms.create("keepAlive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  // The badge is otherwise only redrawn on a snapshot, and endTime passing
  // produces none. Every period, so it clears within ~24 s of a session's end.
  if (alarm.name === "keepAlive") updateBadge();
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
    sendResponse({ isLocked: isLockedNow(), blocklist: activeDynamicBlacklist });
  } else if (request.action === "FORCE_UNLOCK") {
    forceUnlocked = true;
    updateBadge();
    sendResponse({ status: "unlocked" });
  } else if (request.type === "GET_TIMER_STATE") {
    chrome.storage.local.get(["timeLeft", "focusActive"], (res) => {
      sendResponse({ timeLeft: res.timeLeft, focusActive: res.focusActive });
    });
    return true;
  }
});
