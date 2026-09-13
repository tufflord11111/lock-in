import { initializeApp } from "firebase/app";
import { getDatabase, ref, onValue, update, set, forceWebSockets } from "firebase/database";
import { getAuth, onAuthStateChanged } from "firebase/auth/web-extension";

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
let isLocked = false;
let activeDynamicBlacklist = [...STATIC_BLACKLIST];
let permanentBlocklist = [];
let userUnsub = null;
let signalUnsub = null;
let heartbeatInterval = null;

// ─── Session Management ───────────────────────────────────────────────────────
function startLockInSession(uid) {
  if (activeUid === uid) return;
  
  stopLockInSession();
  activeUid = uid;

  // Start Heartbeat
  pulseHeartbeat();
  heartbeatInterval = setInterval(pulseHeartbeat, 30000);

  // 1. Firebase Listener: users/{id} (full lock state + session blocklist)
  //    global_session/state was a single node shared by every user — the last
  //    person to start a session set everyone's blocklist — and is now locked
  //    in the rules. The session blocklist comes from this user's own
  //    sessionState, which arrives in this same snapshot.
  const userRef = ref(db, `users/${activeUid}`);
  userUnsub = onValue(userRef, (snapshot) => {
    const data = snapshot.val();
    if (!data) return;

    const thresholdLimit = data.config?.thresholdLimit || 360;
    const devices = data.devices || {};

    let totalMinutesToday = 0;
    Object.values(devices).forEach(device => {
      totalMinutesToday += (device.minutesToday || 0);
    });

    const now = Date.now();
    const isUnlocked = data.emergencyUnlock?.expiry && now < data.emergencyUnlock.expiry;
    const manualLock = data.isLocked === true;
    const focusActive = data.config?.focusActive === true;

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

    const activeLock = manualLock || focusActive || totalMinutesToday >= thresholdLimit;
    isLocked = activeLock && !isUnlocked;

    console.log("[Lock-In] Session state -> locked:", isLocked, "| blocks:", activeDynamicBlacklist.length);
    console.log("[Blocker] Full active list:", activeDynamicBlacklist);
    updateBadge();
  });

  // 2. Signal Listener: users/{uid}/signals/refreshTabs
  const signalRef = ref(db, `users/${activeUid}/signals/refreshTabs`);
  signalUnsub = onValue(signalRef, async (snapshot) => {
    if (snapshot.val()) {
      console.log('[Tabs] Refresh signal received');
      await syncOpenTabs(activeUid);
    }
  });
}

function stopLockInSession() {
  console.log("[Lock-In] Securing vault. Session stopped.");
  if (userUnsub) userUnsub();
  if (signalUnsub) signalUnsub();
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  
  userUnsub = null;
  signalUnsub = null;
  heartbeatInterval = null;
  activeUid = null;
  isLocked = false;
  activeDynamicBlacklist = [...STATIC_BLACKLIST];
  permanentBlocklist = [];
  updateBadge();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function pulseHeartbeat() {
  if (!activeUid) return;
  const extensionStateRef = ref(db, `users/${activeUid}/extension_state`);
  update(extensionStateRef, {
    last_seen: Date.now(),
    version: chrome.runtime.getManifest().version,
    status: "online"
  }).catch(err => console.error("[Heartbeat Error]:", err));
}

// DISABLED (F5). This used to enumerate every open tab's domain and write the
// list to users/{uid}/openTabs in Firebase — the user's live browsing surface,
// readable by anything with the account. It is no longer collected or sent.
// The "block open tabs" picker in the desktop app is therefore empty; blocking
// a site is done by typing the domain, which needs no browsing-history upload.
async function syncOpenTabs(_uid) {
  return;
}

function getBlockUrl() {
  return chrome.runtime.getURL("block.html");
}

function updateBadge() {
  chrome.action.setBadgeText({ text: isLocked ? "LOCK" : "" });
  chrome.action.setBadgeBackgroundColor({ color: isLocked ? "#FF0000" : "#002855" });
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
    if (isLocked && isDomainBlocked(details.url, activeDynamicBlacklist)) {
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
    if (isLocked && isDomainBlocked(currentUrl, activeDynamicBlacklist)) {
      const urlObj = new URL(currentUrl);
      console.log(`[Lock-In] THREAT BLOCKED: ${urlObj.hostname}`);
      chrome.tabs.remove(tabId);
    }
  } catch (e) {}
});

// ─── Keep-Alive Alarm ─────────────────────────────────────────────────────────
chrome.alarms.create("keepAlive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepAlive" && activeUid) {
    // Keep-alive read against this user's own node — global_session is locked
    // in the rules and would return permission_denied.
    const pingRef = ref(db, `users/${activeUid}/extension_state`);
    onValue(pingRef, () => {}, { onlyOnce: true });
    
    const heartbeatRef = ref(db, `users/${activeUid}/extension_state/last_seen`);
    set(heartbeatRef, Date.now()).catch(() => {});
    syncOpenTabs(activeUid);
    console.log("[Lock-In] Keep-alive ping for:", activeUid);
  }
});

// ─── Message Handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "checkStatus") {
    sendResponse({ isLocked, blocklist: activeDynamicBlacklist });
  } else if (request.action === "FORCE_UNLOCK") {
    isLocked = false;
    updateBadge();
    sendResponse({ status: "unlocked" });
  } else if (request.type === "GET_TIMER_STATE") {
    chrome.storage.local.get(["timeLeft", "focusActive"], (res) => {
      sendResponse({ timeLeft: res.timeLeft, focusActive: res.focusActive });
    });
    return true;
  }
});
