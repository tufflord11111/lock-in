/**
 * Lock-In 1.3.1 Phase B rules proof, against the RTDB EMULATOR only (demo-lockin).
 *
 *  - Item 3: a live guarded session (guard: 2) can't be shortened or cleared,
 *    while every legitimate write still passes: the normal end at the deadline,
 *    the end after a Bail out fuse, Delete Account after the session, and what
 *    Android and the PWA write during one.
 *  - Item 7: users/$uid/proInterest (the Pro waitlist), Android's exact record.
 *  - Item 9: config/study, config/followupHoursLost, config/baselineAt.
 */
const fs = require("node:fs");
const path = require("node:path");
const {
  initializeTestEnvironment, assertSucceeds, assertFails,
} = require("@firebase/rules-unit-testing");
const {
  ref, set, update, remove, get, increment, serverTimestamp,
} = require("firebase/database");

const RULES_FILE =
  process.env.RULES_FILE || path.join(__dirname, "../../database.rules.json");
const RULES = fs.readFileSync(RULES_FILE, "utf8").replace(/^﻿/, "");
const results = [];
async function check(name, expect, fn) {
  try {
    if (expect === "pass") await assertSucceeds(fn());
    else await assertFails(fn());
    results.push({ ok: true, name, expect });
  } catch (e) {
    results.push({ ok: false, name, expect, err: String(e?.message ?? e).slice(0, 160) });
  }
}

const MIN = 60_000;

(async () => {
  const env = await initializeTestEnvironment({
    projectId: "demo-lockin",
    database: { rules: RULES, host: "127.0.0.1", port: 9000 },
  });
  const cfg = (name, extra = {}) => ({
    userName: name.toUpperCase(), email: `${name}@example.com`, createdAt: new Date().toISOString(),
    emailVerified: true, onboardingComplete: true, usernameSet: true, username: name, ...extra,
  });
  const session = (over = {}) => ({
    isActive: true, startedAt: Date.now(), endTime: Date.now() + 30 * MIN, objective: "focus",
    blockedUrls: ["youtube.com"], originDeviceId: "dev-1", guard: 2, ...over,
  });
  const seedUser = async (uid, { sessionState = null, focusActive = sessionState?.isActive === true, config = {}, extra = {} } = {}) =>
    env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await set(ref(db, `users/${uid}`), {
        config: cfg(uid, { focusActive, ...config }), public: { userName: uid.toUpperCase() },
        ...(sessionState ? { sessionState } : {}), ...extra,
      });
      await set(ref(db, `usernames/${uid}`), uid);
    });
  const as = (uid, verified = true) => env.authenticatedContext(uid, { email_verified: verified }).database();
  const endWrite = (uid) => ({
    [`users/${uid}/sessionState`]: { isActive: false, originDeviceId: "dev-1" },
    [`users/${uid}/config/focusActive`]: false,
  });
  /** Android's record (CloudRecord.of, android-v01), as the phone writes it. */
  const androidRecord = (status = "completed") => ({
    minutes: status === "bailed-out" ? 0 : 25, timestamp: Date.now(), status, reason: "timer", device: "android",
    ...(status === "bailed-out" ? { bailedOut: true } : {}),
  });
  /** Android's Pro waitlist record (ProInterest.record, android-v01), verbatim. */
  const androidPro = () => ({
    at: Date.now(), source: "android", features: ["day plan", "deeper stats"], price: "S$3", version: 1,
  });

  // ══ Item 3: the freeze, and every legitimate path around it ═══════════════
  await seedUser("f1", { sessionState: session() });
  const f1 = as("f1");
  await check("freeze: config/focusActive false refused while live", "fail", () => set(ref(f1, "users/f1/config/focusActive"), false));
  await check("freeze: remove(config/focusActive) refused while live", "fail", () => remove(ref(f1, "users/f1/config/focusActive")));
  await check("freeze: an earlier sessionState/endTime refused", "fail",
    () => set(ref(f1, "users/f1/sessionState/endTime"), Date.now() + 5 * MIN));
  await check("freeze: remove(sessionState/endTime) refused", "fail", () => remove(ref(f1, "users/f1/sessionState/endTime")));
  await check("freeze: remove(sessionState) refused", "fail", () => remove(ref(f1, "users/f1/sessionState")));
  await check("freeze: the end write before the deadline refused", "fail", () => update(ref(f1), endWrite("f1")));
  await check("freeze: a later endTime (session extended) passes", "pass",
    () => set(ref(f1, "users/f1/sessionState/endTime"), Date.now() + 45 * MIN));
  // What Android writes, during the desktop's live session.
  await check("live: Android session upload (androidSessionHistory) passes", "pass",
    () => set(ref(f1, "users/f1/androidSessionHistory/android-1"), androidRecord()));
  await check("live: Android bailed-out upload passes", "pass",
    () => set(ref(f1, "users/f1/androidSessionHistory/android-2"), androidRecord("bailed-out")));
  await check("live: Android Pro waitlist answer passes", "pass",
    () => set(ref(f1, "users/f1/proInterest"), androidPro()));
  // What the PWA (the same web app in a browser) writes during one.
  await check("live: PWA theme change passes", "pass", () => set(ref(f1, "users/f1/config/theme"), "notebook"));
  await check("live: PWA presence passes", "pass",
    () => set(ref(f1, "users/f1/presence"), { state: "online", lastChanged: serverTimestamp() }));
  await check("live: PWA adding a block passes", "pass", () => set(ref(f1, "users/f1/customBlocks/x_com"), "x.com"));
  await check("live: baseline answer passes", "pass", () => set(ref(f1, "users/f1/config/baselineHoursLost"), 3));
  // Delete Account waits for the session (B2: the app says so first).
  await check("live: Delete Account refused until the session ends", "fail",
    () => update(ref(f1), { "users/f1": null, "usernames/f1": null }));

  // The normal end, at the deadline.
  await seedUser("f2", { sessionState: session({ endTime: Date.now() - 1000 }) });
  await check("deadline: the normal end write passes", "pass", () => update(ref(as("f2")), {
    ...endWrite("f2"),
    "users/f2/sessionHistory/session-1": { objective: "focus", minutes: 30, timestamp: Date.now(), status: "completed" },
    "users/f2/history/2026-11-19": increment(30),
  }));
  await seedUser("f3", { sessionState: session({ endTime: Date.now() + 60_000 }) });
  await check("deadline: the end write inside the 120 s grace passes", "pass", () => update(ref(as("f3")), endWrite("f3")));

  // Bail out: the fuse arms, burns down, and then the end write passes.
  await seedUser("f4", { sessionState: session() });
  const f4 = as("f4");
  await check("bail out: arming the fuse 5 min out passes", "pass",
    () => set(ref(f4, "users/f4/sessionState/bailoutEnd"), Date.now() + 5 * MIN));
  await check("bail out: ending while the fuse burns refused", "fail", () => update(ref(f4), endWrite("f4")));
  await seedUser("f5", { sessionState: session({ bailoutEnd: Date.now() - 1000 }) });
  await check("bail out: the voided end write after the fuse passes", "pass", () => update(ref(as("f5")), {
    ...endWrite("f5"),
    "users/f5/sessionHistory/session-2": { objective: "focus", minutes: 0, timestamp: Date.now(), status: "bailed-out", bailedOut: true },
  }));

  // Delete Account once the session is over: desktop's and Android's shapes.
  await seedUser("f6", { sessionState: session({ endTime: Date.now() - 1000 }) });
  await check("after: desktop Delete Account passes", "pass",
    () => update(ref(as("f6")), { "users/f6": null, "usernames/f6": null }));
  await seedUser("f7", { sessionState: session({ isActive: false, endTime: Date.now() - 1000 }), focusActive: false });
  await check("after: Android Delete Account (users/uid + owned handles) passes", "pass",
    () => update(ref(as("f7")), { "users/f7": null, "usernames/f7": null }));
  // No session at all: Android uploads and deletes as before.
  await seedUser("f8");
  await check("idle: Android upload passes", "pass",
    () => set(ref(as("f8"), "users/f8/androidSessionHistory/android-3"), androidRecord()));
  await check("idle: Android Delete Account passes", "pass",
    () => update(ref(as("f8")), { "users/f8": null, "usernames/f8": null }));

  // ══ Item 7: proInterest (the Pro waitlist) ════════════════════════════════
  await seedUser("w1");
  await seedUser("w2");
  const w1 = as("w1");
  const desktopPro = (over = {}) => ({
    at: Date.now(), source: "desktop", notify: true, price: "S$3", features: ["deeper stats", "scheduled sessions"], version: 1, ...over,
  });
  await check("pro: the desktop record passes", "pass", () => set(ref(w1, "users/w1/proInterest"), desktopPro()));
  await check("pro: the desktop record without optional answers passes", "pass",
    () => set(ref(w1, "users/w1/proInterest"), { at: Date.now(), source: "desktop", notify: true, version: 1 }));
  // Android's record, exactly as android-v01 rules.test.cjs writes it (a fixed `at`).
  await check("pro: Android's record, verbatim, passes", "pass",
    () => set(ref(w1, "users/w1/proInterest"), { at: 1794300000000, source: "android", features: ["day plan", "deeper stats"], price: "S$3", version: 1 }));
  await check("pro: Android's record with a live `at` passes", "pass", () => set(ref(w1, "users/w1/proInterest"), androidPro()));
  await check("pro: \"I wouldn't pay\" passes", "pass", () => set(ref(w1, "users/w1/proInterest"), desktopPro({ price: "I wouldn't pay" })));
  await check("pro: all five features pass", "pass", () => set(ref(w1, "users/w1/proInterest"),
    desktopPro({ features: ["parrot outfits and perches", "day plan", "the pack pro", "deeper stats", "scheduled sessions"] })));
  await check("pro: another uid can't write it", "fail", () => set(ref(as("w2"), "users/w1/proInterest"), desktopPro()));
  await check("pro: signed out can't write it", "fail",
    () => set(ref(env.unauthenticatedContext().database(), "users/w1/proInterest"), desktopPro()));
  await check("pro: another uid can't read it", "fail", () => get(ref(as("w2"), "users/w1/proInterest")));
  await check("pro: source \"web\" refused", "fail", () => set(ref(w1, "users/w1/proInterest"), desktopPro({ source: "web" })));
  await check("pro: price \"S$9\" refused", "fail", () => set(ref(w1, "users/w1/proInterest"), desktopPro({ price: "S$9" })));
  await check("pro: an unknown feature refused", "fail", () => set(ref(w1, "users/w1/proInterest"), desktopPro({ features: ["cheaper bail-outs"] })));
  await check("pro: a sixth feature slot refused", "fail", () => set(ref(w1, "users/w1/proInterest"),
    desktopPro({ features: { 0: "day plan", 5: "deeper stats" } })));
  await check("pro: an extra field refused", "fail", () => set(ref(w1, "users/w1/proInterest"), desktopPro({ email: "w1@example.com" })));
  await check("pro: version 2 refused", "fail", () => set(ref(w1, "users/w1/proInterest"), desktopPro({ version: 2 })));
  await check("pro: an `at` far in the future refused", "fail", () => set(ref(w1, "users/w1/proInterest"), desktopPro({ at: Date.now() + 10 * MIN })));
  await check("pro: notify \"yes\" refused", "fail", () => set(ref(w1, "users/w1/proInterest"), desktopPro({ notify: "yes" })));
  await check("pro: without `source` refused", "fail", () => set(ref(w1, "users/w1/proInterest"), { at: Date.now(), version: 1 }));
  await check("pro: deleting your own passes", "pass", () => remove(ref(w1, "users/w1/proInterest")));
  await check("pro: Delete Account with an answer stored passes", "pass", async () => {
    await set(ref(w1, "users/w1/proInterest"), desktopPro());
    return update(ref(w1), { "users/w1": null, "usernames/w1": null });
  });

  //@@ITEM9@@

  // State checks (admin read).
  let state = {};
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    const v = async (p) => (await get(ref(db, p))).val();
    state = {
      f1_still_live: (await v("users/f1/sessionState/isActive")) === true && (await v("users/f1/config/focusActive")) === true,
      f1_end_not_earlier: (await v("users/f1/sessionState/endTime")) > Date.now() + 40 * MIN,
      f2_ended: (await v("users/f2/sessionState/isActive")) === false,
      f5_ended: (await v("users/f5/sessionState/isActive")) === false,
      f6_node: await v("users/f6"),
    };
  });
  await env.cleanup();

  const pad = Math.max(...results.map((r) => r.name.length));
  for (const r of results)
    console.log(`${r.ok ? "PASS" : "FAIL"}  expect=${r.expect.padEnd(4)}  ${r.name.padEnd(pad)}${r.ok ? "" : "  <- " + r.err}`);
  console.log("\nstate after run:", JSON.stringify(state));
  const failed = results.filter((r) => !r.ok).length;
  const want = { f1_still_live: true, f1_end_not_earlier: true, f2_ended: true, f5_ended: true, f6_node: null };
  const stateBad = Object.entries(want).filter(([k, val]) => JSON.stringify(state[k]) !== JSON.stringify(val));
  for (const [k, val] of stateBad) console.log(`STATE FAIL  ${k}: ${JSON.stringify(state[k])}, expected ${JSON.stringify(val)}`);
  console.log(`\n${results.length - failed}/${results.length} Phase B checks behaved as expected; state ${stateBad.length ? "WRONG" : "ok"}`);
  process.exit(failed || stateBad.length ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
