// node --test scripts/study.test.cjs — the study report on made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const { summarize, print, CAVEATS } = require("./study.cjs");

const DAY = 86_400_000;
const NOW = Date.parse("2026-12-31T12:00:00");
const T0 = NOW - 40 * DAY;
const iso = (ms) => new Date(ms).toLocaleDateString("en-CA");

function person(i, { consented = true, handle = `user${i}`, followup = 2, baseline = 4 } = {}) {
  const history = {};
  for (let d = 0; d < 28; d += 2) history[iso(T0 + d * DAY + 3_600_000)] = 30 + i;
  return {
    config: {
      username: handle, email: `${handle}@example.com`,
      baselineHoursLost: baseline,
      ...(followup === null ? {} : { followupHoursLost: { value: followup, askedAt: T0 + 14 * DAY, answeredAt: T0 + 14 * DAY } }),
      study: { consented, consentedAt: T0, v: 1 },
    },
    history,
    sessionHistory: {
      a: { timestamp: T0 + DAY, status: "completed", minutes: 30 },
      b: { timestamp: T0 + 2 * DAY, status: "bailed-out", bailedOut: true, minutes: 0 },
      old: { timestamp: T0 - DAY, status: "bailed-out", bailedOut: true, minutes: 0 },
    },
  };
}

function capture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

test("counts only consenters, leaves out demo, reviewer and test accounts", () => {
  const users = {};
  for (let i = 0; i < 6; i++) users[`uid${i}`] = person(i);
  users.uidNo = person(9, { consented: false });
  users.ghost_operator_1 = person(10);
  users.uidTest = person(11, { handle: "lockintest10" });
  users.uidRev = person(12, { handle: "msreview" });
  const out = summarize(users, NOW);
  assert.equal(out.consented, 6);
  assert.equal(out.paired, 6);
});

test("prints totals only: no handles, uids, emails or per-user rows, and both caveats", () => {
  const users = {};
  for (let i = 0; i < 6; i++) users[`uid${i}`] = person(i);
  const text = capture(() => print(summarize(users, NOW)));
  for (let i = 0; i < 6; i++) {
    assert.ok(!text.includes(`uid${i}`), "no uid");
    assert.ok(!text.includes(`user${i}`), "no handle");
  }
  assert.ok(!text.includes("@"), "no email");
  for (const c of CAVEATS) assert.ok(text.includes(c), c);
  assert.match(text, /Self-reported/);
  assert.match(text, /Self-selected/);
  assert.match(text, /Hours lost a day, first answer: median \/ mean\s+4 \/ 4/);
  assert.match(text, /Change per person: median \/ mean\s+-2 \/ -2/);
  // 2 of 3 sessions since consenting... per person: 1 bailed of 2 counted (the older one is before consent).
  assert.match(text, /Sessions ended by Bail out\s+50\.0% of 12/);
});

test("anything from fewer than 5 people shows as <5", () => {
  const users = {};
  for (let i = 0; i < 4; i++) users[`uid${i}`] = person(i);
  const text = capture(() => print(summarize(users, NOW)));
  assert.match(text, /People who turned it on: <5/);
  assert.match(text, /Hours lost a day, first answer: median \/ mean\s+<5 \/ <5/);
  assert.match(text, /Sessions ended by Bail out\s+<5/);
  assert.ok(!/\b4 \/ 4\b/.test(text));
  // 6 consented but only 3 answered both: the paired cells are <5.
  const more = {};
  for (let i = 0; i < 6; i++) more[`uid${i}`] = person(i, { followup: i < 3 ? 1 : null });
  const t2 = capture(() => print(summarize(more, NOW)));
  assert.match(t2, /People who turned it on: 6/);
  assert.match(t2, /Answered both hours-lost questions\s+<5/);
});

test("the report script is read-only", () => {
  const src = require("node:fs").readFileSync(require.resolve("./study.cjs"), "utf8");
  assert.match(src, /study\.cjs is read-only: refused/);
  // The only database calls are getDatabase().ref("users") and ref.once("value").
  assert.ok(!/\bref\.(set|update|remove|push|transaction)\(/.test(src), "no write calls");
  assert.match(src, /await ref\.once\("value"\)/);
});
