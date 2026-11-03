#!/usr/bin/env node
/**
 * Read-only report on the anonymous research writes from lockinme.com.
 *
 * The site has no SDK and no login, so research/quiz and research/payIntent
 * accept unauthenticated creates (database.rules.json). The rules make them
 * create-only and write-only: nothing can be edited, deleted or read back
 * from the browser, and the only children allowed are the ones below. There
 * is no IP, no user agent and no free text to report on, by design.
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
 *     pnpm report:research
 *
 * Same credentials as retention.cjs. The service account file is yours and
 * stays out of the repo; nothing here reads a key from anywhere except that
 * environment variable.
 */
const fs = require("node:fs");
const { initializeApp, applicationDefault, getApp, deleteApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { getAuth } = require("firebase-admin/auth");
// firebase-admin 14 removed the legacy `admin` namespace; this shim keeps the call sites below unchanged.
const admin = {
  initializeApp,
  credential: { applicationDefault },
  database: () => getDatabase(),
  auth: () => getAuth(),
  app: () => ({ delete: () => deleteApp(getApp()) }),
};

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!keyPath) {
  fail(
    "GOOGLE_APPLICATION_CREDENTIALS is not set.\n" +
      "  Point it at a service account JSON for the Lock-In project:\n\n" +
      "    GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json pnpm report:research"
  );
}
if (!fs.existsSync(keyPath)) {
  fail(`GOOGLE_APPLICATION_CREDENTIALS points at a file that does not exist:\n  ${keyPath}`);
}

let projectId;
try {
  projectId = JSON.parse(fs.readFileSync(keyPath, "utf8")).project_id;
} catch (err) {
  fail(`Could not read the service account JSON: ${err.message}`);
}
if (!projectId) fail("The service account JSON has no project_id.");

// asia-southeast1, so NOT the default {project}-default-rtdb.firebaseio.com
// the SDK assumes. Same override as retention.cjs.
const DEFAULT_DATABASE_URL =
  "https://synchrofocus-ac0f2-default-rtdb.asia-southeast1.firebasedatabase.app";
const databaseURL =
  process.env.FIREBASE_DATABASE_URL ||
  (projectId === "synchrofocus-ac0f2"
    ? DEFAULT_DATABASE_URL
    : `https://${projectId}-default-rtdb.firebaseio.com`);

admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL });

/** A ref whose write methods throw. Enforcement, not a comment. */
const WRITE_METHODS = ["set", "update", "remove", "push", "transaction", "setWithPriority", "setPriority"];
function readOnlyRef(path) {
  const ref = admin.database().ref(path);
  for (const method of WRITE_METHODS) {
    ref[method] = () => {
      throw new Error(`research-report.cjs is read-only: refused ${method}() on /${path}`);
    };
  }
  return ref;
}

const WORST_APPS = ["discord", "youtube", "tiktok", "games", "instagram", "other"];

function median(sorted) {
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function dateRange(timestamps) {
  if (!timestamps.length) return "—";
  const lo = Math.min(...timestamps);
  const hi = Math.max(...timestamps);
  return isoDay(lo) === isoDay(hi) ? isoDay(lo) : `${isoDay(lo)} to ${isoDay(hi)}`;
}

(async () => {
  const [quizSnap, paySnap] = await Promise.all([
    readOnlyRef("research/quiz").once("value"),
    readOnlyRef("research/payIntent").once("value"),
  ]);

  const quiz = Object.values(quizSnap.val() || {});
  const pay = Object.values(paySnap.val() || {});

  const hours = quiz
    .map((r) => r.hoursLost)
    .filter((h) => typeof h === "number")
    .sort((a, b) => a - b);
  const mean = hours.length ? hours.reduce((a, b) => a + b, 0) / hours.length : null;
  const exams = quiz.filter((r) => r.examsSoon === true).length;

  const counts = new Map(WORST_APPS.map((w) => [w, 0]));
  for (const r of quiz) {
    if (counts.has(r.worstApp)) counts.set(r.worstApp, counts.get(r.worstApp) + 1);
  }

  const allTs = [...quiz, ...pay].map((r) => r.ts).filter((t) => typeof t === "number");
  const n = quiz.length;
  const pct = (k) => (n ? `${((k / n) * 100).toFixed(1)}%` : "—");
  const num = (v) => (v === null ? "—" : v.toFixed(2));

  console.log("\nLock-In — anonymous research report");
  console.log(`  source     ${databaseURL}`);
  console.log(`  generated  ${new Date().toISOString()}`);
  console.log(`  covering   ${dateRange(allTs)}`);
  console.log("");
  console.log(`  quiz responses        ${n}`);
  console.log(`  hoursLost median      ${num(median(hours))}`);
  console.log(`  hoursLost mean        ${num(mean)}`);
  console.log(`  exams soon            ${exams}  (${pct(exams)})`);
  console.log("");
  console.log("  worst app");
  for (const w of WORST_APPS) {
    const k = counts.get(w);
    const bar = n ? "#".repeat(Math.round((k / n) * 30)) : "";
    console.log(`    ${w.padEnd(10)} ${String(k).padStart(4)}  ${pct(k).padStart(6)}  ${bar}`);
  }
  console.log("");
  console.log(`  payIntent clicks      ${pay.length}`);
  console.log("");

  if (!n && !pay.length) {
    console.log("  Nothing recorded yet.\n");
  }

  await admin.app().delete();
})().catch((err) => {
  console.error("\n  research-report failed:", err.message, "\n");
  process.exit(1);
});
