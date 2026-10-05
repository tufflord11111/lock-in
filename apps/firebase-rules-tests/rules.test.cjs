/**
 * Rules proof for database.rules.json against the RTDB EMULATOR only
 * (project demo-lockin — a demo- project id can never reach production).
 * Payloads mirror the real clients; source lines noted.
 */
const fs = require("node:fs");
const path = require("node:path");
const {
  initializeTestEnvironment, assertSucceeds, assertFails,
} = require("@firebase/rules-unit-testing");
const { ref, set, update, remove, get, push, increment, serverTimestamp } = require("firebase/database");

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

(async () => {
  const env = await initializeTestEnvironment({
    projectId: "demo-lockin",
    database: { rules: RULES, host: "127.0.0.1", port: 9000 },
  });

  const cfg = (name) => ({
    userName: name.toUpperCase(), email: `${name}@example.com`, createdAt: new Date().toISOString(),
    emailVerified: false, onboardingComplete: false, usernameSet: true, username: name,
  });

  // Seed with rules disabled (admin), mirroring live shapes.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    await set(ref(db, "users/alice"), {
      config: cfg("alice"), public: { userName: "ALICE" },
      openTabs: { t0: { domain: "example.com", title: "x", favIconUrl: "" } },
    });
    await set(ref(db, "users/dave"), {
      config: cfg("dave"), public: { userName: "DAVE" },
      extension_state: { last_seen: 1, status: "online", version: "1.2.0" },
      emergencyUnlock: { expiry: Date.now() + 3600000 },
    });
    await set(ref(db, "usernames/dave"), "dave");
    // erin: a session that ended offline and never reached the server —
    // focusActive and sessionState still true, endTime in the past.
    await set(ref(db, "users/erin"), {
      config: cfg("erin"), public: { userName: "ERIN" },
      sessionState: {
        isActive: true, endTime: Date.now() - 60000, originDeviceId: "dev-erin",
        blockedUrls: ["x.com"], objective: "stranded",
      },
      history: { "2026-09-17": 10 },
      emergencyUnlock: { expiry: Date.now() + 3600000 },
    });
    // frank, gina: legacy accounts — handle only at the top level
    // (users/{uid}/username + usernameSet), none in config/. gina's old handle
    // "carol" is reserved by carol in the registration check below.
    const legacyCfg = (name) => ({ ...cfg(name), usernameSet: false, username: null });
    await set(ref(db, "users/frank"), { config: legacyCfg("frank"), username: "FRANK", usernameSet: true });
    await set(ref(db, "users/gina"), { config: legacyCfg("gina"), username: "CAROL", usernameSet: true });
    // bob: authenticated, but no users/bob node at all (no config).
  });

  const alice = env.authenticatedContext("alice").database();
  const bob   = env.authenticatedContext("bob").database();
  const carol = env.authenticatedContext("carol").database();
  const dave  = env.authenticatedContext("dave").database();
  const erin  = env.authenticatedContext("erin").database();
  const frank = env.authenticatedContext("frank").database();
  const gina  = env.authenticatedContext("gina").database();
  const hb = () => ({ last_seen: Date.now(), version: "1.2.1", status: "online" });

  // ── uid WITH config ────────────────────────────────────────────────────────
  // background.js pulseHeartbeat uses update() on the node; test set() of the
  // whole node as specified, plus the real update() call.
  await check("WITH config: set extension_state (whole node)", "pass",
    () => set(ref(alice, "users/alice/extension_state"), hb()));
  await check("WITH config: update extension_state (background.js:159 call shape)", "pass",
    () => update(ref(alice, "users/alice/extension_state"), hb()));
  await check("WITH config: set extension_state/last_seen (keep-alive, background.js:253)", "pass",
    () => set(ref(alice, "users/alice/extension_state/last_seen"), Date.now()));
  await check("WITH config: set openTabs (whole node, store 1.0.7 shape)", "fail",
    () => set(ref(alice, "users/alice/openTabs"), { t1: { domain: "a.com", title: "a", favIconUrl: "" } }));
  await check("WITH config: set openTabs/0", "fail",
    () => set(ref(alice, "users/alice/openTabs/0"), { domain: "a.com" }));
  await check("WITH config: delete openTabs", "pass",
    () => remove(ref(alice, "users/alice/openTabs")));

  // ── uid WITHOUT config ─────────────────────────────────────────────────────
  await check("WITHOUT config: set extension_state", "fail",
    () => set(ref(bob, "users/bob/extension_state"), hb()));
  await check("WITHOUT config: set extension_state/last_seen", "fail",
    () => set(ref(bob, "users/bob/extension_state/last_seen"), Date.now()));

  // ── Registration: apps/web/src/hooks/useAuth.ts:195-211 (mobile identical) ──
  await check("Registration atomic update (config + public + usernames/{key})", "pass",
    () => update(ref(carol), {
      "users/carol/config": cfg("carol"),
      "users/carol/public": { userName: "CAROL" },
      "usernames/carol": "carol",
    }));

  // ── 1.2.4 friend add: resolve a handle to a uid (useFriends.ts) ───────────
  // usernames/$name is readable by any signed-in user as a single-key read;
  // only listing or querying the whole index is restricted. carol reserved
  // "carol" in the registration check above.
  await check("Friend lookup: point-read of another user's handle resolves to their uid", "pass",
    async () => {
      const snap = await get(ref(alice, "usernames/carol"));
      if (snap.val() !== "carol") {
        throw new Error(`resolved to ${JSON.stringify(snap.val())}, expected "carol"`);
      }
      return snap;
    });

  // ── 1.2.4 legacy handle migration: useHandleProfile.ts reserveHandleUpdates ─
  const reserveUpdates = (uid, handle) => ({
    [`users/${uid}/config/username`]: handle,
    [`users/${uid}/config/usernameSet`]: true,
    [`users/${uid}/config/userName`]: handle.toUpperCase(),
    [`users/${uid}/public/userName`]: handle.toUpperCase(),
    [`usernames/${handle}`]: uid,
    [`users/${uid}/username`]: null,
    [`users/${uid}/usernameSet`]: null,
  });
  await check("Legacy migrate: move top-level handle into config/ and reserve usernames/{handle} atomically", "pass",
    () => update(ref(frank), reserveUpdates("frank", "frank")));
  await check("Legacy migrate: denied when the handle is taken — nothing lands", "fail",
    () => update(ref(gina), reserveUpdates("gina", "carol")));

  // ── Delete Account: DeleteAccountButton.tsx (subtree + reservations) ────────
  await check("Delete Account multi-path null (with emergencyUnlock + extension_state present)", "pass",
    () => update(ref(dave), { "users/dave": null, "usernames/dave": null }));

  // ── The actual incident: stale heartbeat after deletion ────────────────────
  await check("AFTER delete: stale heartbeat set extension_state/last_seen must not recreate node", "fail",
    () => set(ref(dave, "users/dave/extension_state/last_seen"), Date.now()));
  await check("AFTER delete: stale heartbeat update extension_state must not recreate node", "fail",
    () => update(ref(dave, "users/dave/extension_state"), hb()));

  // ── 1.2.3 boot reconciliation: useFocusSession.ts RECONCILE effect ─────────
  await check("Reconcile stale session: {config/focusActive:false, sessionState/isActive:false} (emergencyUnlock present)", "pass",
    () => update(ref(erin), {
      "users/erin/config/focusActive": false,
      "users/erin/sessionState/isActive": false,
    }));

  // ── 1.2.3 session end: useFocusSession.ts endSession, one atomic update ─────
  // History key generated client-side; push() with no value writes nothing.
  const erinHistoryKey = push(ref(erin, "users/erin/sessionHistory")).key;
  await check("Session end: 4-path atomic update (client key, serverTimestamp, increment)", "pass",
    () => update(ref(erin), {
      "users/erin/sessionState": { isActive: false, originDeviceId: "dev-erin" },
      "users/erin/config/focusActive": false,
      [`users/erin/sessionHistory/${erinHistoryKey}`]: {
        objective: "stranded", minutes: 5, timestamp: serverTimestamp(), status: "completed",
      },
      "users/erin/history/2026-09-17": increment(5),
    }));
  await check("Session end shape written by ANOTHER uid is denied", "fail",
    () => update(ref(alice), {
      "users/erin/config/focusActive": false,
      "users/erin/sessionState": { isActive: false, originDeviceId: "dev-alice" },
    }));

  // ── 1.2.5 theme + accent enums, and the handle privacy rule ───────────────
  for (const theme of ["operator", "notebook", "bento", "botanical"]) {
    await check(`config/theme "${theme}" is accepted`, "pass",
      () => set(ref(alice, "users/alice/config/theme"), theme));
  }
  await check('config/theme "neon" is rejected', "fail",
    () => set(ref(alice, "users/alice/config/theme"), "neon"));

  for (const accent of ["orange", "sage", "lavender", "teal"]) {
    await check(`config/themeAccent "${accent}" is accepted`, "pass",
      () => set(ref(alice, "users/alice/config/themeAccent"), accent));
  }
  await check('config/themeAccent "pink" is rejected', "fail",
    () => set(ref(alice, "users/alice/config/themeAccent"), "pink"));

  // No part of an email may ever become the handle other users read.
  await check('public/userName "foo@bar" is rejected', "fail",
    () => set(ref(alice, "users/alice/public/userName"), "foo@bar"));
  await check('public/userName "N1NJLA" is accepted', "pass",
    () => set(ref(alice, "users/alice/public/userName"), "N1NJLA"));

  // ── 1.2.6 baseline question ───────────────────────────────────────────────
  for (const hours of [0, 3, 12, 24]) {
    await check(`config/baselineHoursLost ${hours} is accepted`, "pass",
      () => set(ref(alice, "users/alice/config/baselineHoursLost"), hours));
  }
  await check("config/baselineHoursLost 25 is rejected", "fail",
    () => set(ref(alice, "users/alice/config/baselineHoursLost"), 25));
  await check("config/baselineHoursLost -1 is rejected", "fail",
    () => set(ref(alice, "users/alice/config/baselineHoursLost"), -1));
  await check('config/baselineHoursLost "3" (string) is rejected', "fail",
    () => set(ref(alice, "users/alice/config/baselineHoursLost"), "3"));

  // State assertions (admin read)
  let state = {};
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    state = {
      alice_openTabs: (await get(ref(db, "users/alice/openTabs"))).val(),
      alice_last_seen_set: typeof (await get(ref(db, "users/alice/extension_state/last_seen"))).val() === "number",
      bob_node: (await get(ref(db, "users/bob"))).val(),
      carol_key: (await get(ref(db, "usernames/carol"))).val(),
      dave_node: (await get(ref(db, "users/dave"))).val(),
      dave_key: (await get(ref(db, "usernames/dave"))).val(),
      erin_focusActive: (await get(ref(db, "users/erin/config/focusActive"))).val(),
      frank_reserved: (await get(ref(db, "usernames/frank"))).val(),
      frank_config_usernameSet: (await get(ref(db, "users/frank/config/usernameSet"))).val(),
      frank_legacy_fields_gone:
        (await get(ref(db, "users/frank/username"))).val() === null &&
        (await get(ref(db, "users/frank/usernameSet"))).val() === null,
      carol_key_still_carol: (await get(ref(db, "usernames/carol"))).val(),
      gina_config_usernameSet: (await get(ref(db, "users/gina/config/usernameSet"))).val(),
      gina_legacy_username_untouched: (await get(ref(db, "users/gina/username"))).val(),
      erin_sessionState: (await get(ref(db, "users/erin/sessionState"))).val(),
      erin_history_today: (await get(ref(db, "users/erin/history/2026-09-17"))).val(),
      erin_history_entry_timestamp_is_number:
        typeof (await get(ref(db, `users/erin/sessionHistory/${erinHistoryKey}/timestamp`))).val() === "number",
      erin_emergencyUnlock_kept:
        typeof (await get(ref(db, "users/erin/emergencyUnlock/expiry"))).val() === "number",
    };
  });

  await env.cleanup();

  const pad = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  expect=${r.expect.padEnd(4)}  ${r.name.padEnd(pad)}${r.ok ? "" : "  <- " + r.err}`);
  }
  console.log("\nstate after run:", JSON.stringify(state));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks behaved as expected`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
