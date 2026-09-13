import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "firebase/auth/web-extension";

// ─── Firebase Config ──────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyAmN21K_oWOUX2XZKkYJEFsDs1pmb7o17k",
  authDomain: "synchrofocus-ac0f2.firebaseapp.com",
  databaseURL: "https://synchrofocus-ac0f2-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "synchrofocus-ac0f2",
  storageBucket: "synchrofocus-ac0f2.firebasestorage.app",
  messagingSenderId: "987876678302",
  // No forceWebSockets here: the popup uses Firebase Auth only and never opens
  // a Realtime Database connection, so there is no transport to configure.
  appId: "1:987876678302:web:ecb82346b89f6e5f12798f",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// ─── UI Elements ──────────────────────────────────────────────────────────────
const loginView = document.getElementById('loginView');
const menuView = document.getElementById('menuView');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const logoutWarning = document.getElementById('logoutWarning');
const errorDiv = document.getElementById('error');
const statusDiv = document.getElementById('status');
const userInfoDiv = document.getElementById('userInfo');
const syncBtn = document.getElementById('sync');
const sessionHint = document.getElementById('sessionHint');

// ─── View Management ─────────────────────────────────────────────────────────
function showView(view) {
  loginView.classList.add('hidden');
  menuView.classList.add('hidden');
  if (view === 'login') loginView.classList.remove('hidden');
  if (view === 'menu') menuView.classList.remove('hidden');
}

// ─── Auth Logic ──────────────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  if (user) {
    await chrome.storage.local.set({ uid: user.uid });
    userInfoDiv.textContent = `ID: ${user.uid.substring(0, 8)}...`;
    showView('menu');
  } else {
    await chrome.storage.local.remove('uid');
    showView('login');
  }
});

loginBtn.addEventListener('click', async () => {
  const email = emailInput.value;
  const password = passwordInput.value;
  errorDiv.classList.add('hidden');
  loginBtn.disabled = true;
  loginBtn.textContent = 'Syncing...';

  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    errorDiv.textContent = err.message;
    errorDiv.classList.remove('hidden');
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Login';
  }
});

function updateLogoutButton(isSessionActive) {
  if (isSessionActive) {
    logoutBtn.disabled = true;
    logoutBtn.style.opacity = '0.3';
    logoutBtn.style.cursor = 'not-allowed';
    logoutBtn.style.pointerEvents = 'none';
    if (logoutWarning) logoutWarning.style.display = 'block';
  } else {
    logoutBtn.disabled = false;
    logoutBtn.style.opacity = '1';
    logoutBtn.style.cursor = 'pointer';
    logoutBtn.style.pointerEvents = 'auto';
    if (logoutWarning) logoutWarning.style.display = 'none';
  }
}

logoutBtn.addEventListener('click', async (e) => {
  if (logoutBtn.disabled) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  try {
    await signOut(auth);
  } catch (err) {
    console.error("Logout failed:", err);
  }
});

// ─── Menu Actions ────────────────────────────────────────────────────────────
function updateUI() {
  chrome.runtime.sendMessage({ action: "checkStatus" }, (response) => {
    if (response) {
      statusDiv.textContent = response.isLocked ? "LOCKED" : "UNLOCKED";
      statusDiv.className = `status ${response.isLocked ? 'locked' : ''}`;
      updateLogoutButton(response.isLocked);
      // Signed in but nothing enforcing: tell the user where a session starts,
      // instead of leaving the popup looking dead.
      if (sessionHint) sessionHint.classList.toggle('hidden', response.isLocked);
    }
  });
}

syncBtn.addEventListener('click', updateUI);

// Initial Status Check
updateUI();
