/**
 * Static check of database.rules.json (no emulator): the session freeze lives in
 * one place, users/$uid/.write (B2's guard: 2, bailoutEnd, 120 s grace), and no
 * deeper .write under users/$uid hands the owner a grant on a path the guard
 * protects. In RTDB a .write that passes grants that path and everything under
 * it, so a nested grant on sessionState, config, config/focusActive, isLocked
 * (or a path between them and $uid) would bypass the parent's guard.
 *
 * Prints every .write under users/$uid at any depth.
 */
const fs = require("fs");
const path = require("path");

const RULES_FILE = process.env.RULES_FILE || path.join(__dirname, "../../database.rules.json");
const rules = JSON.parse(fs.readFileSync(RULES_FILE, "utf8").replace(/^﻿/, "")).rules;

let failures = 0;
let checks = 0;
function check(name, ok, detail) {
  checks++;
  if (ok) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}${detail ? `\n        <- ${detail}` : ""}`);
  }
}

// Every rule of a given kind, with its path, anywhere under a node.
function collect(node, prefix, kind, out = []) {
  for (const [k, v] of Object.entries(node)) {
    if (k === kind) out.push({ path: prefix, rule: v });
    else if (v && typeof v === "object") collect(v, `${prefix}/${k}`, kind, out);
  }
  return out;
}

const user = rules.users.$uid;
const writes = collect(user, "users/$uid", ".write");
console.log("Every .write under users/$uid:");
for (const w of writes) console.log(`  ${w.path}  ->  ${String(w.rule).slice(0, 90)}${String(w.rule).length > 90 ? "…" : ""}`);

// The only grants: the guarded parent, and a friend removing itself.
check(
  "exactly two .write rules under users/$uid: the guard and friends/$fid",
  JSON.stringify(writes.map((w) => w.path)) === JSON.stringify(["users/$uid", "users/$uid/friends/$fid"]),
  writes.map((w) => w.path).join(", "),
);

const PROTECTED = ["sessionState", "config", "config/focusActive", "isLocked", "sessionState/endTime", "sessionState/isActive", "sessionState/guard", "sessionState/bailoutEnd"];
for (const w of writes.filter((w) => w.path !== "users/$uid")) {
  const rel = w.path.slice("users/$uid/".length);
  const touches = PROTECTED.filter((p) => p === rel || p.startsWith(rel + "/") || rel.startsWith(p + "/"));
  check(`${w.path} is not on, above or below a guarded path`, touches.length === 0, touches.join(", "));
}

const wild = Object.keys(user).filter((k) => k.startsWith("$") && JSON.stringify(user[k]).includes('".write"'));
check("no $wildcard child of users/$uid carries a .write (it would match sessionState and config)", wild.length === 0, wild.join(", "));

const friend = user.friends.$fid[".write"];
check(
  "friends/$fid .write is a delete by that friend only",
  friend === "auth != null && auth.uid === $fid && !newData.exists()",
  friend,
);

// The guard itself: one copy, with B2's design.
const guard = user[".write"];
for (const piece of [
  "data.child('sessionState/guard').val() === 2",
  "data.child('sessionState/endTime').val() > now + 120000",
  "data.child('sessionState/bailoutEnd').val() <= now",
  "newData.child('sessionState/endTime').val() >= data.child('sessionState/endTime').val()",
  "(newData.child('config/focusActive').val() === true || data.child('config/focusActive').val() !== true)",
  "newData.child('isLocked').val() === data.child('isLocked').val()",
  "newData.child('sessionState/bailoutEnd').val() >= now + 270000",
]) {
  check(`guard contains ${piece}`, guard.includes(piece));
}

const all = [...collect(rules, "", ".write"), ...collect(rules, "", ".validate")];
const mentions = (s) => all.filter((r) => typeof r.rule === "string" && r.rule.includes(s)).map((r) => r.path);
check("focusActive is referenced only by the guard", JSON.stringify(mentions("focusActive")) === JSON.stringify(["/users/$uid"]), mentions("focusActive").join(", "));
check("isLocked is referenced only by the guard", JSON.stringify(mentions("isLocked")) === JSON.stringify(["/users/$uid"]), mentions("isLocked").join(", "));
check("endTime is referenced only by the guard", JSON.stringify(mentions("endTime")) === JSON.stringify(["/users/$uid"]), mentions("endTime").join(", "));

// sessionState, config and isLocked carry no .write of their own.
check("sessionState has no .write", !JSON.stringify(user.sessionState).includes('".write"'));
check("config has no .write", !JSON.stringify(user.config).includes('".write"'));
check("isLocked has no rule node", !("isLocked" in user));

console.log(`${checks - failures}/${checks} structure checks behaved as expected`);
process.exit(failures ? 1 : 0);
