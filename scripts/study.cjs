#!/usr/bin/env node
/**
 * Read-only report for the optional study (1.3.1): does Lock-In help?
 *
 * Only accounts with config/study/consented === true are counted, minus the
 * same demo, reviewer and test accounts retention.cjs leaves out. It prints
 * totals and averages only: no handles, uids or emails, and no per-user rows.
 * Any figure drawn from fewer than 5 people prints as "<5".
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
 *     pnpm report:study
 *
 * Like retention.cjs it never writes: every read goes through a ref whose write
 * methods throw. The service account file stays out of the repo.
 */
const fs = require("node:fs");

// ── Who is not a real operator (as retention.cjs) ──────────────────────────
const GHOST_PREFIX = "ghost_operator_";
const EXCLUDED_HANDLES = new Set(["lockinreviewer", "msreview", "t122", "t124", "t125", "t127", "t128", "t12456"]);
const EXCLUDED_HANDLE_PREFIXES = ["lockintest"];
function isExcluded(uid, user) {
  if (uid.startsWith(GHOST_PREFIX)) return true;
  const handle = String(user?.config?.username ?? user?.public?.userName ?? "").toLowerCase();
  return EXCLUDED_HANDLES.has(handle) || EXCLUDED_HANDLE_PREFIXES.some((p) => handle.startsWith(p));
}

const DAY = 86_400_000;
const MIN_CELL = 5;

/** "YYYY-MM-DD" in local time, matching what the app writes into history/. */
const isoDay = (ms) => new Date(ms).toLocaleDateString("en-CA");

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** A cell: "<5" below MIN_CELL people, else the value rounded. */
function cell(n, value, digits = 1) {
  if (n < MIN_CELL) return "<5";
  return value === null ? "-" : Number(value.toFixed(digits)).toString();
}

/** Minutes in history/ for local days in [from, to). */
function minutesBetween(history, from, to) {
  let total = 0;
  for (let t = from; t < to; t += DAY) {
    const v = history?.[isoDay(t)];
    if (typeof v === "number" && v > 0) total += v;
  }
  return total;
}

/**
 * Everything the report prints, from users/ as read. Pure, so it is tested
 * (scripts/study.test.cjs) without a database.
 */
function summarize(users, now) {
  const people = [];
  for (const [uid, u] of Object.entries(users ?? {})) {
    if (!u || isExcluded(uid, u)) continue;
    const study = u.config?.study;
    if (study?.consented !== true || typeof study.consentedAt !== "number") continue;
    people.push(u);
  }
  const out = { consented: people.length, rows: [] };

  // Hours lost: the baseline answer and the day-14 answer, people with both.
  const paired = people.filter(
    (u) => typeof u.config?.baselineHoursLost === "number" && typeof u.config?.followupHoursLost?.value === "number"
  );
  const before = paired.map((u) => u.config.baselineHoursLost);
  const after = paired.map((u) => u.config.followupHoursLost.value);
  const change = paired.map((u) => u.config.followupHoursLost.value - u.config.baselineHoursLost);
  out.paired = paired.length;
  out.rows.push(["Answered both hours-lost questions", cell(paired.length, paired.length, 0)]);
  out.rows.push(["Hours lost a day, first answer: median / mean", `${cell(paired.length, median(before))} / ${cell(paired.length, mean(before))}`]);
  out.rows.push(["Hours lost a day, day-14 answer: median / mean", `${cell(paired.length, median(after))} / ${cell(paired.length, mean(after))}`]);
  out.rows.push(["Change per person: median / mean", `${cell(paired.length, median(change))} / ${cell(paired.length, mean(change))}`]);

  // Focus minutes in each of the first four weeks after consenting.
  for (let week = 1; week <= 4; week++) {
    const reached = people.filter((u) => u.config.study.consentedAt + week * 7 * DAY <= now);
    const mins = reached.map((u) => {
      const start = u.config.study.consentedAt + (week - 1) * 7 * DAY;
      return minutesBetween(u.history, start, start + 7 * DAY);
    });
    out.rows.push([`Focus minutes in week ${week}: median / mean (n ${cell(reached.length, reached.length, 0)})`,
      `${cell(reached.length, median(mins), 0)} / ${cell(reached.length, mean(mins), 0)}`]);
  }

  // Days with any focus in the first 28 days.
  const month = people.filter((u) => u.config.study.consentedAt + 28 * DAY <= now);
  const days = month.map((u) => {
    let n = 0;
    for (let t = u.config.study.consentedAt; t < u.config.study.consentedAt + 28 * DAY; t += DAY) {
      const v = u.history?.[isoDay(t)];
      if (typeof v === "number" && v > 0) n++;
    }
    return n;
  });
  out.rows.push([`Days with focus in the first 28: median / mean (n ${cell(month.length, month.length, 0)})`,
    `${cell(month.length, median(days), 0)} / ${cell(month.length, mean(days))}`]);

  // How often sessions end in a Bail out, since consenting. Counted over people.
  let sessions = 0;
  let bailed = 0;
  let withSessions = 0;
  for (const u of people) {
    const entries = Object.values(u.sessionHistory ?? {}).filter(
      (e) => e && typeof e.timestamp === "number" && e.timestamp >= u.config.study.consentedAt
    );
    if (entries.length) withSessions++;
    sessions += entries.length;
    bailed += entries.filter((e) => e.status === "bailed-out" || e.bailedOut === true).length;
  }
  out.rows.push(["Sessions ended by Bail out", withSessions < MIN_CELL ? "<5" : `${((100 * bailed) / Math.max(sessions, 1)).toFixed(1)}% of ${sessions}`]);
  return out;
}

const CAVEATS = [
  "Self-reported: the hours-lost answers are what people said, and history and sessionHistory are written by each person's own app and account, so they can be wrong or changed.",
  "Self-selected: the people who turned this on chose to, so they are not a random sample of Lock-In users, and nothing here compares them with people who don't use it.",
];

function print(out) {
  console.log("\nLock-In: optional study, totals only\n");
  console.log(`  People who turned it on: ${cell(out.consented, out.consented, 0)}`);
  const pad = Math.max(...out.rows.map((r) => r[0].length));
  for (const [label, value] of out.rows) console.log(`  ${label.padEnd(pad)}  ${value}`);
  console.log(`\n  Figures from fewer than ${MIN_CELL} people show as "<5".`);
  console.log("\nCaveats");
  for (const c of CAVEATS) console.log(`  - ${c}`);
  console.log("");
}

async function main() {
  const { initializeApp, applicationDefault } = require("firebase-admin/app");
  const { getDatabase } = require("firebase-admin/database");
  const fail = (m) => {
    console.error(`\n  ${m}\n`);
    process.exit(1);
  };
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath) fail("GOOGLE_APPLICATION_CREDENTIALS is not set. Point it at a service account JSON for the Lock-In project.");
  if (!fs.existsSync(keyPath)) fail(`GOOGLE_APPLICATION_CREDENTIALS points at a file that does not exist:\n  ${keyPath}`);
  let projectId;
  try {
    projectId = JSON.parse(fs.readFileSync(keyPath, "utf8")).project_id;
  } catch (err) {
    fail(`Could not read the service account JSON: ${err.message}`);
  }
  const databaseURL =
    process.env.FIREBASE_DATABASE_URL ||
    (projectId === "synchrofocus-ac0f2"
      ? "https://synchrofocus-ac0f2-default-rtdb.asia-southeast1.firebasedatabase.app"
      : `https://${projectId}-default-rtdb.firebaseio.com`);
  initializeApp({ credential: applicationDefault(), databaseURL });
  const ref = getDatabase().ref("users");
  for (const m of ["set", "update", "remove", "push", "transaction", "setWithPriority", "setPriority"]) {
    ref[m] = () => {
      throw new Error(`study.cjs is read-only: refused ${m}() on /users`);
    };
  }
  const snap = await ref.once("value");
  print(summarize(snap.val() ?? {}, Date.now()));
  process.exit(0);
}

module.exports = { summarize, CAVEATS, MIN_CELL, print };
if (require.main === module) main().catch((e) => {
  console.error(e);
  process.exit(1);
});
