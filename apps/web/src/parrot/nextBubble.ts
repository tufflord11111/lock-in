/**
 * Whether the parrot may speak, and what it says. Pure: time is always passed
 * in and compared with stored timestamps, never counted in ticks, so a late or
 * throttled check (or a laptop waking up) fires whatever is due, once.
 */
import { HELLO_LINE, NUDGE_LINES, OPEN_APP_LINE, SESSION_DONE_LINE, SESSION_OVER_LINE } from "./lines";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
/** The hard floor between two shown bubbles, whatever the settings say. */
export const MIN_BUBBLE_GAP_MS = 30 * MINUTE;
export const USER_IDLE_MS = 5 * MINUTE;

export type Settings = {
  enabled: boolean;
  nudgeAfterMin: number;
  quietStart: string;
  quietEnd: string;
};

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  nudgeAfterMin: 30,
  quietStart: "22:00",
  quietEnd: "08:00",
};

export type Memory = {
  lastSessionEndAt: number;
  /** Only a bubble that was actually shown sets this. */
  lastBubbleAt: number | null;
  /** Covers both Quiet 1h and Quiet today. */
  quietUntil: number | null;
  helloShown: boolean;
};

export type World = {
  sessionActive: boolean;
  hidden: boolean;
  userIdle: boolean;
};

export type BubbleAction = "start25" | "notNow" | "quiet1h";
export type BubbleKind = "hello" | "nudge" | "sessionDone" | "sessionOver" | "openApp";
export type Bubble = { kind: BubbleKind; text: string; actions: BubbleAction[] };

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** Inside local quiet hours. The range may wrap midnight; start === end is empty. */
export function inQuietHours(now: number, quietStart: string, quietEnd: string): boolean {
  const d = new Date(now);
  const at = d.getHours() * 60 + d.getMinutes();
  const start = minutesOf(quietStart);
  const end = minutesOf(quietEnd);
  if (start === end) return false;
  return start < end ? at >= start && at < end : at >= start || at < end;
}

/** The next local time quietEnd comes round, strictly after now. */
export function nextQuietEnd(now: number, quietEnd: string): number {
  const [h, m] = quietEnd.split(":").map(Number);
  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
  if (today > now) return today;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, h, m).getTime();
}

export const quiet1hUntil = (now: number, current: number | null): number =>
  Math.max(now + HOUR, current ?? 0);

export const quietTodayUntil = (now: number, quietEnd: string, current: number | null): number =>
  Math.max(nextQuietEnd(now, quietEnd), current ?? 0);

/** The checks every unprompted bubble has to pass. */
function maySpeak(now: number, settings: Settings | null, memory: Memory, world: World): settings is Settings {
  if (!settings || !settings.enabled) return false;
  if (world.sessionActive || world.hidden || world.userIdle) return false;
  if (memory.quietUntil !== null && now < memory.quietUntil) return false;
  if (inQuietHours(now, settings.quietStart, settings.quietEnd)) return false;
  if (memory.lastBubbleAt !== null && now - memory.lastBubbleAt < MIN_BUBBLE_GAP_MS) return false;
  return true;
}

/** The periodic check: at most one bubble, however long the check was delayed. */
export function nextBubble(now: number, settings: Settings | null, memory: Memory, world: World): Bubble | null {
  if (!maySpeak(now, settings, memory, world)) return null;
  const gap = Math.max(settings.nudgeAfterMin * MINUTE, MIN_BUBBLE_GAP_MS);
  if (memory.lastBubbleAt !== null && now - memory.lastBubbleAt < gap) return null;
  if (now - memory.lastSessionEndAt < gap) return null;
  if (!memory.helloShown) return { kind: "hello", text: HELLO_LINE, actions: ["quiet1h"] };
  const line = NUDGE_LINES[Math.floor(now / MINUTE) % NUDGE_LINES.length];
  return { kind: "nudge", text: line, actions: ["start25", "notNow", "quiet1h"] };
}

/** The line when a session ends. Same limits as any other unprompted bubble. */
export function sessionEndBubble(
  now: number,
  reason: string,
  settings: Settings | null,
  memory: Memory,
  world: World,
): Bubble | null {
  if (!maySpeak(now, settings, memory, world)) return null;
  return reason === "deadline-expired"
    ? { kind: "sessionDone", text: SESSION_DONE_LINE, actions: ["quiet1h"] }
    : { kind: "sessionOver", text: SESSION_OVER_LINE, actions: ["quiet1h"] };
}

/** The answer to a click on Start 25 that could not start. It answers the user, so no limits. */
export const openAppBubble = (): Bubble => ({ kind: "openApp", text: OPEN_APP_LINE, actions: ["quiet1h"] });
