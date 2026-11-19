/**
 * Security 1.3.1 B2 rules proof, against the RTDB EMULATOR only (demo-lockin).
 *
 *  - guard: 2 sessions (1.3.1) can't be switched off from the owner's own token
 *    before endTime (120 s grace) unless a bail-out fuse has burned down;
 *    bailoutEnd is write-once and at least ~5 min out.
 *  - Everything 1.3.0 writes (sessions without guard) still passes.
 *  - Presence is readable only by people the owner added; friend requests.
 *  - Handles: first claim needs no verification, later claims and friend adds do;
 *    a handle change releases the old one; public/userName is a handle.
 */
const fs = require("node:fs");
const path = require("node:path");
const {
  initializeTestEnvironment, assertSucceeds, assertFails,
} = require("@firebase/rules-unit-testing");
const {
  ref, set, update, remove, get, push, increment, serverTimestamp, onDisconnect,
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
    blockedUrls: ["youtube.com"], originDeviceId: "dev-1", ...over,
  });
  /** A user mid-session, as the server holds it. guard: 2 = started by 1.3.1. */
  const seedUser = async (uid, { sessionState = null, focusActive = sessionState?.isActive === true, extra = {} } = {}) =>
    env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await set(ref(db, `users/${uid}`), {
        config: cfg(uid, { focusActive }), public: { userName: uid.toUpperCase() },
        ...(sessionState ? { sessionState } : {}), ...extra,
      });
      await set(ref(db, `usernames/${uid}`), uid);
    });
  const as = (uid, verified = true) => env.authenticatedContext(uid, { email_verified: verified }).database();
  const endWrite = (uid) => ({
    [`users/${uid}/sessionState`]: { isActive: false, originDeviceId: "dev-1" },
    [`users/${uid}/config/focusActive`]: false,
  });
  const startWrite = (uid, over = {}) => ({
    [`users/${uid}/sessionState`]: session({ guard: 2, ...over }),
    [`users/${uid}/config/focusActive`]: true,
  });

  // ══ Item 1: guard: 2 — during a live session ══════════════════════════════
  await seedUser("g1", { sessionState: session({ guard: 2 }), extra: { friends: { g2: true } } });
  const g1 = as("g1");
  // Must be ALLOWED during a live guarded session.
  await check("live guard: presence set (usePresence shape)", "pass",
    () => set(ref(g1, "users/g1/presence"), { state: "locked-in", lastChanged: serverTimestamp() }));
  await check("live guard: presence onDisconnect().set", "pass",
    () => onDisconnect(ref(g1, "users/g1/presence")).set({ state: "offline", lastChanged: serverTimestamp() }));
  await check("live guard: config/theme", "pass", () => set(ref(g1, "users/g1/config/theme"), "bento"));
  await check("live guard: settings/calendarUrl", "pass",
    () => set(ref(g1, "users/g1/settings/calendarUrl"), "https://example.com/cal.ics"));
  await check("live guard: config/companion update", "pass",
    () => update(ref(g1, "users/g1/config/companion"), { enabled: false, v: 1 }));
  await check("live guard: adding a block (customBlocks)", "pass",
    () => set(ref(g1, "users/g1/customBlocks/reddit_com"), "reddit.com"));
  await check("live guard: adding a blocked app (blockedApps + meta)", "pass",
    () => update(ref(g1), { "users/g1/blockedApps/discord_exe": "discord.exe", "users/g1/blockedApps_meta/discord_exe": { addedBy: "dev-1" } }));
  await check("live guard: device heartbeat + minutes", "pass",
    () => update(ref(g1, "users/g1/devices/dev-1"), { name: "PC", minutesToday: increment(1), lastSync: Date.now() }));
  await check("live guard: balance", "pass", () => update(ref(g1, "users/g1/balance"), { minutes: 5 }));
  await check("live guard: Web Guard heartbeat (extension_state)", "pass",
    () => update(ref(g1, "users/g1/extension_state"), { last_seen: Date.now(), version: "1.2.6", status: "online" }));
  await check("live guard: sessionHistory record of another session", "pass",
    () => push(ref(g1, "users/g1/sessionHistory"), { objective: "x", minutes: 10, timestamp: serverTimestamp(), status: "completed" }));
  await check("live guard: a NEW session ending later replaces it", "pass",
    () => update(ref(g1), startWrite("g1", { endTime: Date.now() + 60 * MIN })));
  // Must be REFUSED.
  await check("live guard: remove(config/focusActive) refused", "fail", () => remove(ref(g1, "users/g1/config/focusActive")));
  await check("live guard: config/focusActive false refused", "fail", () => set(ref(g1, "users/g1/config/focusActive"), false));
  await check("live guard: remove(sessionState) refused", "fail", () => remove(ref(g1, "users/g1/sessionState")));
  await check("live guard: sessionState/isActive false refused", "fail", () => set(ref(g1, "users/g1/sessionState/isActive"), false));
  await check("live guard: the 1.3.0 end write (whole node off + focusActive false) refused", "fail",
    () => update(ref(g1), endWrite("g1")));
  await check("live guard: reconcile shape before endTime refused", "fail",
    () => update(ref(g1), { "users/g1/config/focusActive": false, "users/g1/sessionState/isActive": false }));
  await check("live guard: earlier endTime refused", "fail",
    () => set(ref(g1, "users/g1/sessionState/endTime"), Date.now() + 5 * MIN));
  await check("live guard: a 'new' session ending sooner refused", "fail",
    () => update(ref(g1), startWrite("g1", { endTime: Date.now() + 1000 })));
  await check("live guard: removing guard refused", "fail", () => remove(ref(g1, "users/g1/sessionState/guard")));
  await check("live guard: guard 1 refused", "fail", () => set(ref(g1, "users/g1/sessionState/guard"), 1));
  await check("live guard: isLocked written refused", "fail", () => set(ref(g1, "users/g1/isLocked"), false));
  await check("live guard: remove(users/uid) refused", "fail", () => remove(ref(g1, "users/g1")));
  await check("live guard: Delete Account multi-path refused", "fail",
    () => update(ref(g1), { "users/g1": null, "usernames/g1": null }));
  await check("live guard: bailoutEnd under 4.5 min out refused", "fail",
    () => set(ref(g1, "users/g1/sessionState/bailoutEnd"), Date.now() + 4 * MIN));
  await check("live guard: bailoutEnd as a string refused", "fail",
    () => set(ref(g1, "users/g1/sessionState/bailoutEnd"), String(Date.now() + 6 * MIN)));
  await check("live guard: arming bailoutEnd 5 min out", "pass",
    () => set(ref(g1, "users/g1/sessionState/bailoutEnd"), Date.now() + 5 * MIN));
  await check("live guard: bailoutEnd can't be moved once armed", "fail",
    () => set(ref(g1, "users/g1/sessionState/bailoutEnd"), Date.now() + 10 * MIN));
  await check("live guard: bailoutEnd can't be removed once armed", "fail",
    () => remove(ref(g1, "users/g1/sessionState/bailoutEnd")));
  await check("live guard: ending while the fuse burns is refused", "fail", () => update(ref(g1), endWrite("g1")));
  await check("another user can't touch a live session", "fail",
    () => set(ref(as("g2"), "users/g1/sessionState/endTime"), Date.now() + 90 * MIN));

  // After the fuse: ending, and a new session, both allowed.
  await seedUser("g3", { sessionState: session({ guard: 2, bailoutEnd: Date.now() - 1000 }) });
  await check("fuse burned down: the end write passes", "pass", () => update(ref(as("g3")), endWrite("g3")));
  await seedUser("g4", { sessionState: session({ guard: 2, bailoutEnd: Date.now() - 1000 }) });
  await check("fuse burned down: a new session passes", "pass",
    () => update(ref(as("g4")), startWrite("g4", { endTime: Date.now() + 25 * MIN })));
  // At and after endTime, and inside the 120 s grace.
  await seedUser("g5", { sessionState: session({ guard: 2, endTime: Date.now() + 60_000 }) });
  await check("inside the 120 s grace: the end write passes", "pass", () => update(ref(as("g5")), endWrite("g5")));
  await seedUser("g6", { sessionState: session({ guard: 2, endTime: Date.now() + 5 * MIN }) });
  await check("outside the 120 s grace: the end write is refused", "fail", () => update(ref(as("g6")), endWrite("g6")));
  await seedUser("g7", { sessionState: session({ guard: 2, endTime: Date.now() - 1000 }) });
  await check("after endTime: the completion write passes", "pass", () => update(ref(as("g7")), {
    ...endWrite("g7"),
    "users/g7/sessionHistory/session-1": { objective: "focus", minutes: 30, timestamp: Date.now(), status: "completed" },
    "users/g7/history/2026-11-19": increment(30),
  }));
  await seedUser("g8", { sessionState: session({ guard: 2, endTime: Date.now() - 1000 }) });
  await check("after endTime: a new session passes", "pass", () => update(ref(as("g8")), startWrite("g8")));
  await seedUser("g9", { sessionState: session({ guard: 2, endTime: Date.now() - 1000 }) });
  await check("after endTime: Delete Account passes", "pass",
    () => update(ref(as("g9")), { "users/g9": null, "usernames/g9": null }));

  // ══ 1.3.0 write patterns (no guard) still pass ════════════════════════════
  const legacy = async (uid) => seedUser(uid, { sessionState: session() });
  await legacy("v1");
  const v1 = as("v1");
  await check("1.3.0: Bail out end mid-session (no guard)", "pass", () => update(ref(v1), endWrite("v1")));
  await legacy("v2");
  await check("1.3.0: disarm recovery step 1, config focusActive false", "pass",
    () => update(ref(as("v2"), "users/v2/config"), { focusActive: false }));
  await check("1.3.0: disarm recovery step 2, sessionState isActive false", "pass",
    () => update(ref(as("v2"), "users/v2/sessionState"), { isActive: false }));
  await check("1.3.0: disarm recovery step 3, aborted record", "pass",
    () => push(ref(as("v2"), "users/v2/sessionHistory"), { objective: "EMERGENCY DISARM", minutes: 0, timestamp: serverTimestamp(), status: "aborted" }));
  await legacy("v3");
  await check("1.3.0: pending-record flush (record + history + clear)", "pass", () => update(ref(as("v3")), {
    "users/v3/sessionHistory/session-99": { objective: "o", minutes: 0, timestamp: 99, status: "bailed-out", bailedOut: true },
    ...endWrite("v3"),
  }));
  await legacy("v4");
  await check("1.3.0: reconcile shape", "pass",
    () => update(ref(as("v4")), { "users/v4/config/focusActive": false, "users/v4/sessionState/isActive": false }));
  await seedUser("v5");
  await check("1.3.0: session start (whole node, no guard)", "pass", () => update(ref(as("v5")), {
    "users/v5/sessionState": session(), "users/v5/config/focusActive": true,
  }));
  await check("1.3.0: start, then Bail out end", "pass", () => update(ref(as("v5")), endWrite("v5")));
  await check("1.3.0: Delete Account multi-path", "pass",
    () => update(ref(as("v5")), { "users/v5": null, "usernames/v5": null }));
  await seedUser("v6");
  const v6 = as("v6");
  for (const [name, fn] of [
    ["presence set", () => set(ref(v6, "users/v6/presence"), { state: "online", lastChanged: serverTimestamp() })],
    ["presence onDisconnect", () => onDisconnect(ref(v6, "users/v6/presence")).set({ state: "offline", lastChanged: serverTimestamp() })],
    ["customBlocks add", () => set(ref(v6, "users/v6/customBlocks/x_com"), "x.com")],
    ["customBlocks remove", () => remove(ref(v6, "users/v6/customBlocks/x_com"))],
    ["permanentBlocks add", () => update(ref(v6), { "users/v6/permanentBlocks/x_com": "x.com" })],
    ["permanentExe add", () => update(ref(v6), { "users/v6/permanentExe/a_exe": "a.exe" })],
    ["removedDefaults", () => set(ref(v6, "users/v6/removedDefaults"), { netflix_com: true })],
    ["settings/calendarUrl remove", () => remove(ref(v6, "users/v6/settings/calendarUrl"))],
    ["config update (onboarding)", () => update(ref(v6, "users/v6/config"), { onboardingComplete: true })],
    ["public/userName sync (uppercase handle)", () => update(ref(v6), { "users/v6/public/userName": "V6" })],
    ["name repair", () => update(ref(v6), { "users/v6/config/userName": "V6", "users/v6/public/userName": "V6", "users/v6/config/nameRepairedAt": serverTimestamp() })],
    ["friend add (verified)", () => set(ref(v6, "users/v6/friends/v1"), true)],
    ["Web Guard heartbeat", () => set(ref(v6, "users/v6/extension_state/last_seen"), Date.now())],
  ]) await check(`1.3.0: ${name}`, "pass", fn);

  // ══ Item 2: presence, friends, friend requests ════════════════════════════
  await seedUser("pa", { extra: { presence: { state: "online" }, friends: { pb: true, pc: true } } });
  await seedUser("pb", { extra: { presence: { state: "online" } } }); // pb hasn't added pa
  await seedUser("pc", { extra: { presence: { state: "online" }, friends: { pa: true } } });
  await seedUser("px", { extra: { presence: { state: "online" } } });
  await check("presence: a stranger can't read it", "fail", () => get(ref(as("px"), "users/pa/presence")));
  await check("presence: one-way, the adder can't read the one who didn't add back", "fail",
    () => get(ref(as("pa"), "users/pb/presence")));
  await check("presence: mutual, pa reads pc", "pass", () => get(ref(as("pa"), "users/pc/presence")));
  await check("presence: mutual, pc reads pa", "pass", () => get(ref(as("pc"), "users/pa/presence")));
  await check("presence: the owner reads their own", "pass", () => get(ref(as("pb"), "users/pb/presence")));
  await check("presence: anon can't read it", "fail", () => get(ref(env.unauthenticatedContext().database(), "users/pa/presence")));
  await check("public/userName still readable by any signed-in user", "pass", () => get(ref(as("px"), "users/pa/public")));

  await seedUser("ra");
  await seedUser("rb");
  await seedUser("rc");
  await seedUser("ru");
  const ra = as("ra"); const rb = as("rb"); const rc = as("rc");
  const request = (from, to) => ({ from, at: serverTimestamp() });
  await check("friend add: verified ra adds rb (own list)", "pass", () => set(ref(ra, "users/ra/friends/rb"), true));
  await check("friend request: ra -> rb created", "pass", () => set(ref(ra, "friendRequests/rb/ra"), request("ra", "rb")));
  await check("friend request: can't be overwritten by the sender", "fail", () => set(ref(ra, "friendRequests/rb/ra"), request("ra", "rb")));
  await check("friend request: a stranger can't read the target's requests", "fail", () => get(ref(rc, "friendRequests/rb")));
  await check("friend request: the requester can't read the target's list", "fail", () => get(ref(ra, "friendRequests/rb")));
  await check("friend request: the requester can't read even its own entry", "fail", () => get(ref(ra, "friendRequests/rb/ra")));
  await check("friend request: the target reads its requests", "pass", () => get(ref(rb, "friendRequests/rb")));
  await check("friend request: a stranger can't delete it", "fail", () => remove(ref(rc, "friendRequests/rb/ra")));
  await check("friend request: rb adds back (friends/rb/ra + request removed, atomic)", "pass",
    () => update(ref(rb), { "users/rb/friends/ra": true, "friendRequests/rb/ra": null }));
  await check("friend request: rc can't send one on ra's behalf", "fail", () => set(ref(rc, "friendRequests/rb/ra"), request("ra", "rb")));
  await check("friend request: needs the sender's own friends entry", "fail", () => set(ref(rc, "friendRequests/rb/rc"), request("rc", "rb")));
  await check("friend add: rc adds rb", "pass", () => set(ref(rc, "users/rc/friends/rb"), true));
  await check("friend request: a wrong 'from' is refused", "fail", () => set(ref(rc, "friendRequests/rb/rc"), { from: "ra", at: serverTimestamp() }));
  await check("friend request: a client-chosen 'at' is refused", "fail", () => set(ref(rc, "friendRequests/rb/rc"), { from: "rc", at: 5 }));
  await check("friend request: an extra field is refused", "fail", () => set(ref(rc, "friendRequests/rb/rc"), { ...request("rc"), note: "hi" }));
  await check("friend request: to a user that doesn't exist is refused", "fail",
    () => update(ref(rc), { "users/rc/friends/nobody": true, "friendRequests/nobody/rc": request("rc") }));
  await check("friend request: rc -> rb created", "pass", () => set(ref(rc, "friendRequests/rb/rc"), request("rc")));
  await check("friend request: the target dismisses it", "pass", () => remove(ref(rb, "friendRequests/rb/rc")));
  await check("friend request: to yourself is refused", "fail", () => set(ref(ra, "friendRequests/ra/ra"), request("ra")));
  await check("friend request: the sender can withdraw its own (Delete Account)", "pass", async () => {
    await set(ref(rc, "friendRequests/rb/rc"), request("rc"));
    await remove(ref(rc, "friendRequests/rb/rc"));
  });
  const ru = as("ru", false);
  await check("unverified: can't add a friend", "fail", () => set(ref(ru, "users/ru/friends/rb"), true));
  await check("unverified: can't send a friend request", "fail", () => set(ref(ru, "friendRequests/rb/ru"), request("ru")));
  await check("unverified: can still remove a friend", "pass", () => remove(ref(ru, "users/ru/friends/rb")));
  await check("unverified: own data still writes (theme)", "pass", () => set(ref(ru, "users/ru/config/theme"), "notebook"));
  await check("unverified: own session start still writes", "pass", () => update(ref(ru), startWrite("ru")));
  await check("friends: a friend removes itself from my list (Delete Account)", "pass", () => remove(ref(rb, "users/ra/friends/rb")));
  await check("friends: a stranger can't remove an entry from my list", "fail", () => remove(ref(rc, "users/ra/friends/rc_not_me")));
  await check("friends: a friend can't add itself to my list", "fail", () => set(ref(rb, "users/ra/friends/rb"), true));
  await check("friends: a friend can't remove someone else from my list", "fail", () => remove(ref(rb, "users/rc/friends/ra")));

  // ══ Item 4: handles ═══════════════════════════════════════════════════════
  await check("handle: registration by an unverified new user (first claim)", "pass", () => update(ref(as("hn", false)), {
    "users/hn/config": { ...cfg("hn"), emailVerified: false },
    "users/hn/public": { userName: "HN" },
    "usernames/hn": "hn",
  }));
  await check("handle: an unverified user with a handle can't claim another", "fail",
    () => set(ref(as("hn", false), "usernames/hn_two"), "hn"));
  await seedUser("hc");
  const hc = as("hc");
  const change = (uid, from, to, over = {}) => ({
    [`users/${uid}/config/username`]: to, [`users/${uid}/config/userName`]: to.toUpperCase(),
    [`users/${uid}/public/userName`]: to.toUpperCase(), [`usernames/${to}`]: uid, [`usernames/${from}`]: null, ...over,
  });
  await check("handle change: without releasing the old handle refused", "fail",
    () => update(ref(hc), change("hc", "hc", "hc_new", { "usernames/hc": "hc" })));
  await check("handle change: config/username to an unreserved handle refused", "fail",
    () => set(ref(hc, "users/hc/config/username"), "hc_other"));
  await check("handle change: verified, old released, new reserved", "pass", () => update(ref(hc), change("hc", "hc", "hc_new")));
  await check("handle change: the old handle is free for someone else", "pass", () => update(ref(as("hz", false)), {
    "users/hz/config": { ...cfg("hz"), username: "hc", emailVerified: false },
    "users/hz/public": { userName: "HC" },
    "usernames/hc": "hz",
  }));
  for (const bad of ["A B", "", "x".repeat(21), "ÉMILE", "a-b", 5])
    await check(`public/userName ${JSON.stringify(bad)} refused`, "fail", () => set(ref(hc, "users/hc/public/userName"), bad));
  for (const good of ["HC_NEW", "a", "X".repeat(20), "Mixed_9"])
    await check(`public/userName ${JSON.stringify(good)} accepted`, "pass", () => set(ref(hc, "users/hc/public/userName"), good));

  // ══ Item 5: Delete Account clean-up, in the order the app sends it ════════
  await seedUser("da", { extra: { friends: { db: true, dc: true }, presence: { state: "online" } } });
  await seedUser("db", { extra: { friends: { da: true } } });
  await seedUser("dc");
  await env.withSecurityRulesDisabled(async (ctx) => {
    await set(ref(ctx.database(), "friendRequests/dc/da"), { from: "da", at: Date.now() });
    await set(ref(ctx.database(), "friendRequests/da/dx"), { from: "dx", at: Date.now() });
  });
  await check("delete: clean-up (out of friends' lists, outgoing and incoming requests) in one update", "pass",
    () => update(ref(as("da")), {
      "users/db/friends/da": null, "users/dc/friends/da": null,
      "friendRequests/db/da": null, "friendRequests/dc/da": null, "friendRequests/da": null,
    }));
  await check("delete: then the account itself", "pass", () => update(ref(as("da")), { "users/da": null, "usernames/da": null }));
  await check("delete: a late presence write (onDisconnect, reconnect) can't recreate the node", "fail",
    () => set(ref(as("da"), "users/da/presence"), { state: "online", lastChanged: serverTimestamp() }));

  // State checks (admin read).
  let state = {};
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    const v = async (p) => (await get(ref(db, p))).val();
    state = {
      g1_still_live: (await v("users/g1/sessionState/isActive")) === true && (await v("users/g1/config/focusActive")) === true,
      g1_bailoutEnd_armed: typeof (await v("users/g1/sessionState/bailoutEnd")) === "number",
      g3_ended: (await v("users/g3/sessionState/isActive")) === false,
      rb_friends_ra: await v("users/rb/friends/ra"),
      rb_requests: await v("friendRequests/rb"),
      hc_old_handle: await v("usernames/hc"),
      hc_new_handle: await v("usernames/hc_new"),
      db_friends_da: await v("users/db/friends/da"),
      dc_request_from_da: await v("friendRequests/dc/da"),
      da_node: await v("users/da"),
    };
  });
  await env.cleanup();

  const pad = Math.max(...results.map((r) => r.name.length));
  for (const r of results)
    console.log(`${r.ok ? "PASS" : "FAIL"}  expect=${r.expect.padEnd(4)}  ${r.name.padEnd(pad)}${r.ok ? "" : "  <- " + r.err}`);
  console.log("\nstate after run:", JSON.stringify(state));
  const failed = results.filter((r) => !r.ok).length;
  const want = {
    g1_still_live: true, g1_bailoutEnd_armed: true, g3_ended: true, rb_friends_ra: true, rb_requests: null,
    hc_old_handle: "hz", hc_new_handle: "hc", db_friends_da: null, dc_request_from_da: null, da_node: null,
  };
  const stateBad = Object.entries(want).filter(([k, val]) => JSON.stringify(state[k]) !== JSON.stringify(val));
  for (const [k, val] of stateBad) console.log(`STATE FAIL  ${k}: ${JSON.stringify(state[k])}, expected ${JSON.stringify(val)}`);
  console.log(`\n${results.length - failed}/${results.length} B2 checks behaved as expected; state ${stateBad.length ? "WRONG" : "ok"}`);
  process.exit(failed || stateBad.length ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
