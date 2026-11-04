import { describe, expect, it } from "vitest";
import { HELLO_LINE, NUDGE_LINES, SESSION_DONE_LINE, SESSION_OVER_LINE } from "./lines";
import * as lines from "./lines";
import {
  DEFAULT_SETTINGS,
  HOUR,
  MINUTE,
  USER_IDLE_MS,
  inQuietHours,
  nextBubble,
  nextQuietEnd,
  openAppBubble,
  quiet1hUntil,
  quietTodayUntil,
  sessionEndBubble,
  type Memory,
  type World,
} from "./nextBubble";

// Local noon, safely outside the default 22:00–08:00.
const NOON = new Date(2026, 10, 4, 12, 0).getTime();
const at = (hours: number, minutes = 0, day = 4) => new Date(2026, 10, day, hours, minutes).getTime();
const AWAKE: World = { sessionActive: false, hidden: false, userIdle: false };
const memory = (over: Partial<Memory> = {}): Memory => ({
  lastSessionEndAt: NOON - 10 * HOUR,
  lastBubbleAt: null,
  quietUntil: null,
  helloShown: true,
  ...over,
});
const next = (now = NOON, m = memory(), w = AWAKE, s = DEFAULT_SETTINGS) => nextBubble(now, s, m, w);

describe("the 30-minute limit", () => {
  it("nudges when nothing has been shown", () => {
    const b = next();
    expect(b?.kind).toBe("nudge");
    expect(NUDGE_LINES).toContain(b?.text);
  });

  it("allows nothing within 30 minutes of a shown bubble", () => {
    expect(next(NOON, memory({ lastBubbleAt: NOON - 29 * MINUTE }))).toBeNull();
    expect(next(NOON, memory({ lastBubbleAt: NOON - 30 * MINUTE + 1 }))).toBeNull();
    expect(next(NOON, memory({ lastBubbleAt: NOON - 30 * MINUTE }))).not.toBeNull();
  });

  it("counts only shown bubbles: a bubble that was due but never shown uses nothing up", () => {
    const m = memory();
    // Due, but the bird was over a full-screen app, so it wasn't shown and
    // nothing wrote lastBubbleAt. The next check, an instant later, may speak.
    expect(next(NOON, m, { ...AWAKE, hidden: true })).toBeNull();
    expect(next(NOON + 1, m)).not.toBeNull();
  });

  it("can't be set below 30 by a lower setting", () => {
    const low = { ...DEFAULT_SETTINGS, nudgeAfterMin: 15 };
    expect(next(NOON, memory({ lastBubbleAt: NOON - 20 * MINUTE }), AWAKE, low)).toBeNull();
    expect(next(NOON, memory({ lastSessionEndAt: NOON - 20 * MINUTE }), AWAKE, low)).toBeNull();
  });

  it("follows a higher setting", () => {
    const slow = { ...DEFAULT_SETTINGS, nudgeAfterMin: 60 };
    expect(next(NOON, memory({ lastBubbleAt: NOON - 59 * MINUTE }), AWAKE, slow)).toBeNull();
    expect(next(NOON, memory({ lastBubbleAt: NOON - 60 * MINUTE }), AWAKE, slow)).not.toBeNull();
  });

  it("waits the same gap after a session ends", () => {
    expect(next(NOON, memory({ lastSessionEndAt: NOON - 29 * MINUTE }))).toBeNull();
    expect(next(NOON, memory({ lastSessionEndAt: NOON - 30 * MINUTE }))).not.toBeNull();
  });
});

describe("sessions", () => {
  it("none during a session", () => {
    expect(next(NOON, memory(), { ...AWAKE, sessionActive: true })).toBeNull();
  });

  it("no session-end line if another session is already running", () => {
    expect(sessionEndBubble(NOON, "deadline-expired", DEFAULT_SETTINGS, memory(), { ...AWAKE, sessionActive: true })).toBeNull();
  });

  it("says the session-end line, happy only for a finished session", () => {
    expect(sessionEndBubble(NOON, "deadline-expired", DEFAULT_SETTINGS, memory(), AWAKE)?.text).toBe(SESSION_DONE_LINE);
    for (const reason of ["bailout-expired", "session-ended-local", "session-ended-remote"]) {
      expect(sessionEndBubble(NOON, reason, DEFAULT_SETTINGS, memory(), AWAKE)?.text).toBe(SESSION_OVER_LINE);
    }
  });

  it("the session-end line obeys the same limit and quiet", () => {
    const end = (m: Memory, now = NOON) => sessionEndBubble(now, "deadline-expired", DEFAULT_SETTINGS, m, AWAKE);
    expect(end(memory({ lastBubbleAt: NOON - 10 * MINUTE }))).toBeNull();
    expect(end(memory({ quietUntil: NOON + 1 }))).toBeNull();
    expect(end(memory(), at(23))).toBeNull();
  });
});

describe("Quiet 1h", () => {
  it("lasts exactly an hour, read from the clock", () => {
    const until = quiet1hUntil(NOON, null);
    expect(until).toBe(NOON + HOUR);
    const m = memory({ quietUntil: until });
    expect(next(NOON + HOUR - 1, m)).toBeNull();
    expect(next(NOON + HOUR, m)).not.toBeNull();
  });

  it("never shortens a longer quiet", () => {
    expect(quiet1hUntil(NOON, NOON + 5 * HOUR)).toBe(NOON + 5 * HOUR);
  });
});

describe("Quiet today", () => {
  it("lasts until the next quietEnd, not until midnight", () => {
    const until = quietTodayUntil(NOON, "08:00", null);
    expect(until).toBe(at(8, 0, 5));
    const m = memory({ quietUntil: until, lastSessionEndAt: NOON });
    expect(next(at(23, 59), m)).toBeNull();
    expect(next(at(0, 1, 5), m)).toBeNull();
    expect(next(at(7, 59, 5), m)).toBeNull();
    expect(next(at(8, 0, 5), m)).not.toBeNull();
  });

  it("before quietEnd the same morning, it ends at that quietEnd", () => {
    expect(nextQuietEnd(at(2), "08:00")).toBe(at(8));
    expect(nextQuietEnd(at(8), "08:00")).toBe(at(8, 0, 5));
    expect(nextQuietEnd(at(7, 59), "08:00")).toBe(at(8));
  });

  it("follows the user's quietEnd", () => {
    expect(quietTodayUntil(NOON, "06:30", null)).toBe(at(6, 30, 5));
  });

  it("never shortens a longer quiet", () => {
    const far = at(8, 0, 9);
    expect(quietTodayUntil(NOON, "08:00", far)).toBe(far);
  });
});

describe("quiet hours", () => {
  it("wrap midnight", () => {
    expect(inQuietHours(at(22), "22:00", "08:00")).toBe(true);
    expect(inQuietHours(at(23, 59), "22:00", "08:00")).toBe(true);
    expect(inQuietHours(at(0), "22:00", "08:00")).toBe(true);
    expect(inQuietHours(at(7, 59), "22:00", "08:00")).toBe(true);
    expect(inQuietHours(at(8), "22:00", "08:00")).toBe(false);
    expect(inQuietHours(at(21, 59), "22:00", "08:00")).toBe(false);
  });

  it("work within a day", () => {
    expect(inQuietHours(at(13), "12:30", "14:00")).toBe(true);
    expect(inQuietHours(at(14), "12:30", "14:00")).toBe(false);
    expect(inQuietHours(at(12), "12:30", "14:00")).toBe(false);
  });

  it("are empty when start equals end", () => {
    expect(inQuietHours(at(12), "09:00", "09:00")).toBe(false);
  });

  it("silence nudges", () => {
    expect(next(at(23))).toBeNull();
    expect(next(at(8))).not.toBeNull();
  });

  it("follow the settings", () => {
    const lunch = { ...DEFAULT_SETTINGS, quietStart: "11:00", quietEnd: "13:00" };
    expect(next(NOON, memory(), AWAKE, lunch)).toBeNull();
    expect(next(at(23), memory(), AWAKE, lunch)).not.toBeNull();
  });
});

describe("time comes from the clock", () => {
  it("a long sleep gives one bubble, not a backlog", () => {
    const beforeSleep = NOON - 6 * HOUR;
    const m = memory({ lastBubbleAt: beforeSleep });
    const first = next(NOON, m);
    expect(first).not.toBeNull();
    // Shown, so the caller stamps it; the very next check has nothing.
    expect(next(NOON + 30_000, { ...m, lastBubbleAt: NOON })).toBeNull();
  });

  it("the answer depends on now, not on how many times it was asked", () => {
    const m = memory({ lastBubbleAt: NOON - 10 * MINUTE });
    for (let i = 0; i < 1000; i++) expect(next(NOON, m)).toBeNull();
    expect(next(NOON + 20 * MINUTE, m)).not.toBeNull();
  });
});

describe("the other gates", () => {
  it("nothing before settings have arrived", () => {
    expect(nextBubble(NOON, null, memory(), AWAKE)).toBeNull();
  });

  it("nothing when switched off", () => {
    expect(next(NOON, memory(), AWAKE, { ...DEFAULT_SETTINGS, enabled: false })).toBeNull();
  });

  it("nothing over a full-screen app", () => {
    expect(next(NOON, memory(), { ...AWAKE, hidden: true })).toBeNull();
  });

  it("nothing to an empty chair", () => {
    expect(USER_IDLE_MS).toBe(5 * MINUTE);
    expect(next(NOON, memory(), { ...AWAKE, userIdle: true })).toBeNull();
  });
});

describe("what it says", () => {
  it("says hello first, in the same slot", () => {
    const m = memory({ helloShown: false });
    expect(next(NOON, m)?.text).toBe(HELLO_LINE);
    expect(next(NOON, { ...m, lastBubbleAt: NOON - MINUTE })).toBeNull();
  });

  it("a nudge offers Start 25, Not now and Quiet 1h", () => {
    expect(next()?.actions).toEqual(["start25", "notNow", "quiet1h"]);
  });

  it("every bubble has a quiet action", () => {
    const bubbles = [
      next(),
      next(NOON, memory({ helloShown: false })),
      sessionEndBubble(NOON, "deadline-expired", DEFAULT_SETTINGS, memory(), AWAKE),
      sessionEndBubble(NOON, "bailout-expired", DEFAULT_SETTINGS, memory(), AWAKE),
      openAppBubble(),
    ];
    for (const b of bubbles) expect(b?.actions).toContain("quiet1h");
  });

  it("no line claims the app can't be stopped", () => {
    const all = Object.values(lines).flat().join(" ").toLowerCase();
    for (const banned of ["can't turn it off", "no override", "can't stop", "wasted", "streak"]) {
      expect(all).not.toContain(banned);
    }
  });
});
