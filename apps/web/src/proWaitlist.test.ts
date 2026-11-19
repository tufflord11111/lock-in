import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRO_FEATURES, PRO_PRICES, proRecord, showProCard } from "./proWaitlist";
import { COPY_TABLE } from "./theme/copy";

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
// Android's Pro.FEATURES and Pro.PRICES (android-v01 ProInterest.kt), verbatim.
const ANDROID_FEATURES = ["parrot outfits and perches", "day plan", "the pack pro", "deeper stats", "scheduled sessions"];
const ANDROID_PRICES = ["S$2", "S$3", "S$5", "I wouldn't pay"];

describe("Pro waitlist (1.3.1 item 8)", () => {
  it("uses Android's strings exactly, less the day plan the free Planner already is", () => {
    expect([...PRO_PRICES]).toEqual(ANDROID_PRICES);
    expect([...PRO_FEATURES]).toEqual(ANDROID_FEATURES.filter((f) => f !== "day plan"));
    expect(src("./screens/PerformanceLog.tsx")).toMatch(/WeeklyPlan/);
  });

  it("writes Android's proInterest shape, source desktop, unanswered questions left out", () => {
    expect(proRecord({ notify: true }, 5)).toEqual({ at: 5, source: "desktop", notify: true, version: 1 });
    expect(proRecord({ notify: true, price: "S$3", features: ["scheduled sessions", "deeper stats", "cheap bail-outs"] }, 5)).toEqual({
      at: 5, source: "desktop", notify: true, price: "S$3", features: ["deeper stats", "scheduled sessions"], version: 1,
    });
    expect(proRecord({ notify: true, price: "S$9" }, 5).price).toBeUndefined();
  });

  it("shows after the first completed session, once per machine, never during a session or over the baseline", () => {
    const base = { due: true, asked: false, isActive: false, baselineShowing: false };
    expect(showProCard(base)).toBe(true);
    expect(showProCard({ ...base, due: false })).toBe(false);
    expect(showProCard({ ...base, asked: true })).toBe(false);
    expect(showProCard({ ...base, isActive: true })).toBe(false);
    expect(showProCard({ ...base, baselineShowing: true })).toBe(false);
  });

  it("is due only once a completed entry is written, and mounts beside the baseline card", () => {
    expect(src("./hooks/useFocusSession.ts")).toMatch(/logUiEvent\("session-recorded", userId\);\n.*\n\s+if \(record\.status === "completed"\) markProDue\(\);/);
    const app = src("./App.tsx");
    expect(app).toMatch(/onboardingComplete === true &&\n\s+profile\.usernameSet !== false &&\n\s+showProCard\(\{ due: proDueNow, asked: proAskedNow, isActive, baselineShowing: !baselineDone \}\)/);
    const settings = src("./screens/BlockRegistry.tsx");
    const row = settings.indexOf("<ProWaitlistRow");
    expect(row).toBeGreaterThan(settings.indexOf("<CompanionSettings"));
    expect(row).toBeLessThan(settings.indexOf("<DeleteAccountButton"));
  });

  it("goes through awaitWriteOrQueue to users/$uid/proInterest and keeps a local copy", () => {
    const card = src("./components/ProWaitlist.tsx");
    expect(card).toMatch(/awaitWriteOrQueue\(set\(ref\(db, `users\/\$\{userId\}\/proInterest`\), rec\)/);
    expect(card).toMatch(/saveProInterestLocally\(rec\)/);
    expect(src("./proWaitlist.ts")).toMatch(/PRO_INTEREST_KEY = "lockin\.proInterest"/);
    expect(src("./proWaitlist.ts")).toMatch(/PRO_ASKED_KEY = "lockin\.proAsked"/);
  });

  it("has every pro.* line in all four voices, promises the free things stay free, and sells nothing", () => {
    const keys = ["pro.eyebrow", "pro.title", "pro.body", "pro.notify", "pro.notified", "pro.priceQ", "pro.featuresQ", "pro.close", "pro.settingsRow"];
    for (const theme of ["operator", "notebook", "bento", "botanical"] as const) {
      for (const k of keys) expect(COPY_TABLE[theme][k], `${theme} ${k}`).toBeTruthy();
      const body = String(COPY_TABLE[theme]["pro.body"]).toLowerCase();
      for (const free of ["free", "blocking", "bail out", "history"]) expect(body, `${theme}: ${free}`).toContain(free);
      const all = keys.map((k) => String(COPY_TABLE[theme][k]).toLowerCase()).join(" ");
      for (const banned of ["checkout", "buy", "subscribe", "upgrade", "can't turn it off", "no override", "no off switch"]) {
        expect(all, `${theme}: ${banned}`).not.toContain(banned);
      }
    }
    // The card's code, comments left out: no payment anywhere in it.
    const card = src("./components/ProWaitlist.tsx").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").toLowerCase();
    expect(card).not.toMatch(/checkout|stripe|purchase|payment|\$\d/);
  });
});
