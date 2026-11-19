// The optional study (1.3.1): does Lock-In help? Off unless turned on in
// Settings. What it uses is said in CONSENT_TEXT, word for word as agreed;
// scripts/study.cjs reports totals only.

/** Shown beside the switch, word for word. */
export const CONSENT_TEXT =
  "Help us find out whether Lock-In helps. If you turn this on, we'll use your 'hours lost' answers (today, and once more in two weeks), your focus minutes per week, how many days you focus, and how often you bail out. They're only reported as totals and averages across everyone who joins: never your handle, email, or anything that identifies you. Lock-In never collects which sites you visit, so that's not included. Turn this off here any time; your data is left out of every report after that. Reports already made can't be changed.";

export const STUDY_ROW_TITLE = "Help find out whether Lock-In helps";
/** The one optional line under the baseline question. */
export const STUDY_INVITE = "Optional: you can share your answers, without your name, to help find out whether Lock-In helps. It's off unless you turn it on in Settings.";
export const FOLLOWUP_EYEBROW = "Two weeks on";

/** The follow-up is asked 14 days after consenting (decision 3). */
export const FOLLOWUP_AFTER_MS = 14 * 86_400_000;
export const FOLLOWUP_SKIPPED_KEY = "lockin.followupSkipped";

export type StudyState = {
  consented?: boolean;
  consentedAt?: number;
  baselineHoursLost?: number;
  followupAnswered: boolean;
};

/**
 * Ask the day-14 question: consented, a baseline answer to compare with, 14
 * days since consenting, not answered or skipped, no session running, and no
 * other card showing.
 */
export function followupDue(s: StudyState, now: number, opts: { isActive: boolean; otherCard: boolean; skipped: boolean }): boolean {
  return (
    s.consented === true &&
    typeof s.consentedAt === "number" &&
    typeof s.baselineHoursLost === "number" &&
    !s.followupAnswered &&
    now >= s.consentedAt + FOLLOWUP_AFTER_MS &&
    !opts.isActive &&
    !opts.otherCard &&
    !opts.skipped
  );
}

export function followupSkipped(): boolean {
  try {
    return localStorage.getItem(FOLLOWUP_SKIPPED_KEY) === "1";
  } catch {
    return false;
  }
}

export function markFollowupSkipped(): void {
  try {
    localStorage.setItem(FOLLOWUP_SKIPPED_KEY, "1");
  } catch {
    /* asked once more, nothing else */
  }
}
