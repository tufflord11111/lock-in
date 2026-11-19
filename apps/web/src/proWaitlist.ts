// The desktop Pro waitlist (1.3.1). Nothing is sold and nothing is built: it
// records whether someone wants to hear when Pro exists, and optionally what
// they'd use and pay, in Android's proInterest schema (android-v01
// ProInterest.record) so both apps write one shape and the rule
// (database.rules.json users/$uid/proInterest) checks it.

/**
 * Android's Pro.FEATURES, verbatim, less "day plan": the free Planner tab
 * (PerformanceLog, "Strategic Planner") already plans each day, and nothing
 * free moves behind Pro. The rule still accepts "day plan" from Android.
 */
export const PRO_FEATURES = ["parrot outfits and perches", "the pack pro", "deeper stats", "scheduled sessions"] as const;
/** Android's Pro.PRICES, verbatim. Survey answers, not prices. */
export const PRO_PRICES = ["S$2", "S$3", "S$5", "I wouldn't pay"] as const;

export type ProFeature = (typeof PRO_FEATURES)[number];
export type ProPrice = (typeof PRO_PRICES)[number];

export type ProRecord = {
  at: number;
  source: "desktop";
  notify: boolean;
  price?: ProPrice;
  features?: ProFeature[];
  version: 1;
};

/** The record, with unanswered questions left out (the rule allows that). */
export function proRecord(answer: { notify: boolean; price?: string | null; features?: string[] }, at: number): ProRecord {
  const rec: ProRecord = { at, source: "desktop", notify: answer.notify === true, version: 1 };
  if (answer.price && (PRO_PRICES as readonly string[]).includes(answer.price)) rec.price = answer.price as ProPrice;
  // In the order Pro lists them, as Android does, and only known ones.
  const features = PRO_FEATURES.filter((f) => answer.features?.includes(f));
  if (features.length) rec.features = features;
  return rec;
}

export const PRO_INTEREST_KEY = "lockin.proInterest";
export const PRO_ASKED_KEY = "lockin.proAsked";
/** Set when a session's entry went out as "completed": the card may show after it. */
export const PRO_DUE_KEY = "lockin.proDue";
export const PRO_DUE_EVENT = "lockin:pro-due";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: the card may show once more, nothing else */
  }
}

/** Shown once per machine, answered or dismissed. */
export function proAsked(): boolean {
  return read(PRO_ASKED_KEY) === "1";
}

export function markProAsked(): void {
  write(PRO_ASKED_KEY, "1");
}

export function proDue(): boolean {
  return read(PRO_DUE_KEY) === "1";
}

/** Called when a "completed" session entry is written. */
export function markProDue(): void {
  if (proDue()) return;
  write(PRO_DUE_KEY, "1");
  try {
    window.dispatchEvent(new Event(PRO_DUE_EVENT));
  } catch {
    /* no window (tests) */
  }
}

export function savedProInterest(): ProRecord | null {
  const raw = read(PRO_INTEREST_KEY);
  if (!raw) return null;
  try {
    const r = JSON.parse(raw);
    return r && r.source === "desktop" && r.version === 1 ? (r as ProRecord) : null;
  } catch {
    return null;
  }
}

export function saveProInterestLocally(rec: ProRecord): void {
  write(PRO_INTEREST_KEY, JSON.stringify(rec));
}

/**
 * The card's own rule: after the first completed session, once per machine,
 * never while a session runs, and not on top of the baseline question.
 */
export function showProCard(s: { due: boolean; asked: boolean; isActive: boolean; baselineShowing: boolean }): boolean {
  return s.due && !s.asked && !s.isActive && !s.baselineShowing;
}
