#!/usr/bin/env node
/**
 * Read-only retention report.
 *
 * Reads users/ from the RTDB and the Auth user list with the Admin SDK, and
 * prints one row per real operator: handle, when they signed up, how many
 * distinct days they actually logged a session, when the last one was, total
 * minutes, and the extension version their browser last reported.
 *
 * This script never writes. It reads users/ with once('value') and lists Auth
 * users, and the ref it reads through has its write methods replaced by
 * throwers, so a write cannot happen even by accident.
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
 *     pnpm report:retention
 *
 * The service account file is yours and stays out of the repo: .gitignore
 * covers *service-account*.json and *-adminsdk-*.json, and nothing here reads
 * a key from anywhere except that environment variable.
 */
const fs = require("node:fs");
const admin = require("firebase-admin");

// ── Who is not a real operator ──────────────────────────────────────────────
/** Seeded demo rows, keyed by uid. */
const GHOST_PREFIX = "ghost_operator_";
/** The Web Store reviewer account and the throwaway accounts used for release testing. */
const EXCLUDED_HANDLES = new Set(["lockinreviewer", "t122", "t124", "t125"]);

const ACTIVE_DAYS_THRESHOLD = 3;
const RECENT_WINDOW_DAYS = 7;

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!keyPath) {
  fail(
    "GOOGLE_APPLICATION_CREDENTIALS is not set.\n" +
      "  Point it at a service account JSON for the Lock-In project:\n\n" +
      "    GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json pnpm report:retention"
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

const databaseURL =
  process.env.FIREBASE_DATABASE_URL || `https://${projectId}-default-rtdb.firebaseio.com`;

admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL });

/**
 * A database ref with its write methods replaced by throwers. Every read in
 * this script goes through here, so the script cannot write even by accident —
 * this is enforcement, not a comment.
 */
const WRITE_METHODS = ["set", "update", "remove", "push", "transaction", "setWithPriority", "setPriority"];
function readOnlyRef(path) {
  const ref = admin.database().ref(path);
  for (const method of WRITE_METHODS) {
    ref[method] = () => {
      throw new Error(`retention.cjs is read-only: refused ${method}() on /${path}`);
    };
  }
  return ref;
}

/** "YYYY-MM-DD" in local time, matching what the app writes into history/. */
const isoDay = (d) => d.toLocaleDateString("en-CA");

function daysBetween(fromIso, toIso) {
  const a = Date.parse(`${fromIso}T00:00:00`);
  const b = Date.parse(`${toIso}T00:00:00`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.round((b - a) / 86_400_000);
}

/** Every Auth user, as uid -> { created, email }. */
async function listAuthUsers() {
  const byUid = new Map();
  let pageToken;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    for (const u of page.users) {
      byUid.set(u.uid, {
        created: u.metadata.creationTime ? isoDay(new Date(u.metadata.creationTime)) : "—",
        email: u.email || "",
      });
    }
    pageToken = page.pageToken;
  } while (pageToken);
  return byUid;
}

function summarise(node) {
  const history = node.history && typeof node.history === "object" ? node.history : {};
  let activeDays = 0;
  let totalMinutes = 0;
  let last = null;
  for (const [date, minutes] of Object.entries(history)) {
    const m = Number(minutes);
    if (!Number.isFinite(m) || m <= 0) continue;
    activeDays++;
    totalMinutes += m;
    if (!last || date > last) last = date;
  }
  return { activeDays, totalMinutes, last };
}

function handleOf(node) {
  return (
    node?.public?.userName ||
    node?.config?.userName ||
    node?.config?.username ||
    ""
  );
}

(async () => {
  const [authUsers, snapshot] = await Promise.all([
    listAuthUsers(),
    readOnlyRef("users").once("value"),
  ]);

  const users = snapshot.val() || {};
  const today = isoDay(new Date());

  const rows = [];
  let ghosts = 0;
  let excluded = 0;
  let orphans = 0; // a users/ node with no Auth record behind it

  for (const [uid, node] of Object.entries(users)) {
    if (uid.startsWith(GHOST_PREFIX)) {
      ghosts++;
      continue;
    }
    const handle = handleOf(node);
    if (EXCLUDED_HANDLES.has(String(handle).toLowerCase()) || EXCLUDED_HANDLES.has(uid.toLowerCase())) {
      excluded++;
      continue;
    }
    const auth = authUsers.get(uid);
    if (!auth) {
      orphans++;
      continue;
    }

    const { activeDays, totalMinutes, last } = summarise(node);
    rows.push({
      uid,
      handle: handle || "(no handle)",
      created: auth.created,
      activeDays,
      last: last || "—",
      totalMinutes,
      version: node?.extension_state?.version || "—",
      recent: last ? daysBetween(last, today) <= RECENT_WINDOW_DAYS : false,
    });
  }

  rows.sort((a, b) => b.activeDays - a.activeDays || b.totalMinutes - a.totalMinutes);

  const head = ["handle", "created", "active days", "last session", "total mins", "ext version"];
  const cells = rows.map((r) => [
    r.handle,
    r.created,
    String(r.activeDays),
    r.last,
    String(r.totalMinutes),
    r.version,
  ]);
  const width = head.map((h, i) =>
    Math.max(h.length, ...cells.map((c) => c[i].length), 0)
  );
  const NUMERIC = new Set([2, 4]);
  const line = (c) =>
    c.map((v, i) => (NUMERIC.has(i) ? v.padStart(width[i]) : v.padEnd(width[i]))).join("  ");

  console.log("");
  console.log(line(head));
  console.log(width.map((w) => "-".repeat(w)).join("  "));
  for (const c of cells) console.log(line(c));

  const withThree = rows.filter((r) => r.activeDays >= ACTIVE_DAYS_THRESHOLD).length;
  const recent = rows.filter((r) => r.recent).length;

  console.log("");
  console.log(
    `users: ${rows.length}  |  with >=${ACTIVE_DAYS_THRESHOLD} active days: ${withThree}  |  active in the last ${RECENT_WINDOW_DAYS} days: ${recent}`
  );
  console.log(
    `skipped: ${ghosts} ghost_operator_* seed nodes, ${excluded} reviewer/test accounts, ${orphans} users/ nodes with no Auth record`
  );
  console.log("");

  await admin.app().delete();
})().catch((err) => {
  console.error("\n  retention report failed:", err && err.message ? err.message : err, "\n");
  process.exit(1);
});
