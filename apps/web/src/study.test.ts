import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONSENT_TEXT, FOLLOWUP_AFTER_MS, STUDY_INVITE, followupDue } from "./study";

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const DAY = 86_400_000;
const T = 1_800_000_000_000;

describe("optional study UI (1.3.1 item 10)", () => {
  it("shows the agreed consent text word for word", () => {
    expect(CONSENT_TEXT).toBe(
      "Help us find out whether Lock-In helps. If you turn this on, we'll use your 'hours lost' answers (today, and once more in two weeks), your focus minutes per week, how many days you focus, and how often you bail out. They're only reported as totals and averages across everyone who joins: never your handle, email, or anything that identifies you. Lock-In never collects which sites you visit, so that's not included. Turn this off here any time; your data is left out of every report after that. Reports already made can't be changed."
    );
    expect(src("./components/Study.tsx")).toMatch(/\{CONSENT_TEXT\}/);
  });

  it("is off unless turned on: only consented === true counts", () => {
    const study = src("./components/Study.tsx");
    expect(study).toMatch(/consented: c\.study\?\.consented === true/);
    expect(study).toMatch(/const on = study\?\.consented === true;/);
    expect(study).toMatch(/set\(ref\(db, `users\/\$\{userId\}\/config\/study`\), \{ consented: next, consentedAt: serverTimestamp\(\), v: 1 \}\)/);
  });

  it("asks the day-14 question only when it should", () => {
    const s = { consented: true, consentedAt: T, baselineHoursLost: 4, followupAnswered: false };
    const ok = { isActive: false, otherCard: false, skipped: false };
    expect(FOLLOWUP_AFTER_MS).toBe(14 * DAY);
    expect(followupDue(s, T + 14 * DAY, ok)).toBe(true);
    expect(followupDue(s, T + 14 * DAY - 1, ok)).toBe(false);
    expect(followupDue({ ...s, consented: false }, T + 20 * DAY, ok)).toBe(false);
    expect(followupDue({ ...s, baselineHoursLost: undefined }, T + 20 * DAY, ok)).toBe(false);
    expect(followupDue({ ...s, followupAnswered: true }, T + 20 * DAY, ok)).toBe(false);
    expect(followupDue(s, T + 20 * DAY, { ...ok, isActive: true })).toBe(false);
    expect(followupDue(s, T + 20 * DAY, { ...ok, otherCard: true })).toBe(false);
    expect(followupDue(s, T + 20 * DAY, { ...ok, skipped: true })).toBe(false);
  });

  it("asks it as the baseline asked: same words, same 0-12 slider, server time", () => {
    const study = src("./components/Study.tsx");
    expect(study).toMatch(/t\("baseline\.question"\)/);
    expect(study).toMatch(/min=\{0\}\n\s+max=\{12\}/);
    expect(study).toMatch(/\{ value: hours, askedAt, answeredAt: serverTimestamp\(\) \}/);
    expect(src("./components/BaselineQuestion.tsx")).toMatch(/\{ baselineHoursLost: hours, baselineAt: serverTimestamp\(\) \}/);
  });

  it("has one optional invite line under the baseline card, and the row in Settings", () => {
    expect(src("./components/BaselineQuestion.tsx")).toMatch(/\{STUDY_INVITE\}/);
    expect(STUDY_INVITE.toLowerCase()).toContain("off unless you turn it on");
    const settings = src("./screens/BlockRegistry.tsx");
    const row = settings.indexOf("<StudyConsentRow");
    expect(row).toBeGreaterThan(settings.indexOf("<CompanionSettings"));
    expect(row).toBeLessThan(settings.indexOf("<DeleteAccountButton"));
  });

  it("never says study results, proven or research anywhere in the UI", () => {
    const root = fileURLToPath(new URL(".", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(tsx?|css|html)$/.test(name) && !/\.test\.ts$/.test(name)) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      const text = readFileSync(f, "utf8").toLowerCase();
      for (const word of ["study results", "proven", "research"]) expect(text.includes(word), `${f}: ${word}`).toBe(false);
    }
  });
});
