import { initializeApp } from "firebase/app";
import {
  initializeAuth,
  getAuth,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  inMemoryPersistence,
} from "firebase/auth";
import { getDatabase } from "firebase/database";
import { pinDatabaseHost } from "./pinDatabaseHost";

const firebaseConfig = {
  apiKey: "AIzaSyAmN21K_oWOUX2XZKkYJEFsDs1pmb7o17k",
  authDomain: "synchrofocus-ac0f2.firebaseapp.com",
  databaseURL: "https://synchrofocus-ac0f2-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "synchrofocus-ac0f2",
  storageBucket: "synchrofocus-ac0f2.firebasestorage.app",
  messagingSenderId: "987876678302",
  appId: "1:987876678302:web:ecb82346b89f6e5f12798f",
};

export const app = initializeApp(firebaseConfig);

// Explicit persistence fallback chain — critical for Tauri/WebView2.
// IndexedDB can hang during init in embedded webviews; the chain falls
// through to localStorage then memory so onAuthStateChanged always fires.
// Wrapped because initializeAuth throws auth/already-initialized when this
// module is evaluated twice (Vite HMR in dev).
let auth: ReturnType<typeof getAuth>;
try {
  auth = initializeAuth(app, {
    persistence: [
      indexedDBLocalPersistence,
      browserLocalPersistence,
      inMemoryPersistence,
    ],
  });
} catch (e) {
  console.warn("[LOCK-IN] initializeAuth fell back to getAuth:", e);
  auth = getAuth(app);
}
export { auth };

export const db = getDatabase(app);
// The desktop CSP allows only this database's host: keep the SDK on it
// rather than the shard host its handshake names (1.3.1 M10).
if (!pinDatabaseHost(db)) console.warn("[LOCK-IN] couldn't pin the database host; the SDK's shape changed");
