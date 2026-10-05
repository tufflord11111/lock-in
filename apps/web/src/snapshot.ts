/**
 * The last known good state of the signed-in operator, kept on disk by Rust.
 *
 * The RTDB web SDK has no disk cache: offline, onValue simply never fires, so
 * a cold boot has no handle, no streak, no history and no blocklist until the
 * network comes back. In a country where Google is unreachable that is the
 * whole app. This module keeps a copy of everything the dashboard needs in
 * %APPDATA%\com.lockin.app\snapshot.json, written whenever the live listeners
 * fire and read before anything remote is awaited.
 *
 * It holds no tokens. Firebase owns the session; this is only the data the
 * session would have fetched.
 */
import { invoke } from "@tauri-apps/api/core";

const isTauri =
  typeof window !== "undefined" && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

/** Bumped when the shape changes; an older snapshot is ignored rather than guessed at. */
export const SNAPSHOT_VERSION = 2;

export type Snapshot = {
  version: number;
  uid: string;
  savedAt: number;
  handle: string | null;
  config: Record<string, unknown>;
  /** Display list. */
  blockedApps: string[];
  /**
   * The raw key -> exe and key -> deviceId maps. The enforcer push is computed
   * from these, not from the display list: seeding only the list made the push
   * send an empty blocklist and clear the enforcer on an offline boot.
   */
  blockedAppsRaw: Record<string, string>;
  blockedAppsMeta: Record<string, string>;
  permanentExe: string[];
  customBlocks: Record<string, string>;
  permanentBlocks: Record<string, string>;
  removedDefaults: string[];
  friends: { uid: string; name: string }[];
  /** date -> minutes, last 30 days only. */
  history: Record<string, number>;
  /** The 50 most recent entries, newest last. */
  sessionHistory: Record<string, unknown>[];
};

export function emptySnapshot(uid: string): Snapshot {
  return {
    version: SNAPSHOT_VERSION,
    uid,
    savedAt: 0,
    handle: null,
    config: {},
    blockedApps: [],
    blockedAppsRaw: {},
    blockedAppsMeta: {},
    permanentExe: [],
    customBlocks: {},
    permanentBlocks: {},
    removedDefaults: [],
    friends: [],
    history: {},
    sessionHistory: [],
  };
}

/** Trim history to the last 30 days so the file cannot grow without bound. */
export function trimHistory(history: Record<string, number>): Record<string, number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 29);
  const min = cutoff.toLocaleDateString("en-CA");
  const out: Record<string, number> = {};
  for (const [date, minutes] of Object.entries(history ?? {})) {
    if (date >= min && typeof minutes === "number") out[date] = minutes;
  }
  return out;
}

export function trimSessions(sessions: Record<string, unknown> | unknown[]): Record<string, unknown>[] {
  const list = Array.isArray(sessions) ? sessions : Object.values(sessions ?? {});
  return list.filter((s) => s && typeof s === "object").slice(-50) as Record<string, unknown>[];
}

function isSnapshot(v: unknown): v is Snapshot {
  const s = v as Snapshot | null;
  return !!s && typeof s === "object" && s.version === SNAPSHOT_VERSION && typeof s.uid === "string" && !!s.uid;
}

/**
 * The snapshot on disk, or null. Never throws: a missing, unreadable or
 * stale-shaped file is simply "no snapshot", and the app boots as it did before.
 */
export async function readSnapshot(): Promise<Snapshot | null> {
  if (!isTauri) return null;
  try {
    const raw = await invoke<string | null>("read_snapshot");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isSnapshot(parsed) ? parsed : null;
  } catch (err) {
    console.warn("[LOCK-IN] snapshot read failed:", err);
    return null;
  }
}

/** Fire-and-forget. A failed snapshot write must never affect the UI. */
export function writeSnapshot(snapshot: Snapshot): void {
  if (!isTauri) return;
  invoke("write_snapshot", { json: JSON.stringify({ ...snapshot, savedAt: Date.now() }) }).catch((err) =>
    console.warn("[LOCK-IN] snapshot write failed:", err)
  );
}

/**
 * Sign-out and account deletion drop it. The snapshot is what tells the next
 * boot "there was a signed-in operator here", so leaving it behind would open
 * someone else's dashboard.
 */
export async function clearSnapshot(): Promise<void> {
  if (!isTauri) return;
  try {
    await invoke("clear_snapshot");
  } catch (err) {
    console.warn("[LOCK-IN] snapshot clear failed:", err);
  }
}

// ── Boot cache ──────────────────────────────────────────────────────────────
// main.tsx loads this once before the first render, so every component can ask
// for it synchronously in a useState initialiser. That is what makes the
// dashboard paint with real data on frame one rather than after a round trip.
let boot: Snapshot | null = null;

export async function loadBootSnapshot(): Promise<Snapshot | null> {
  boot = await readSnapshot();
  return boot;
}

/** The snapshot this launch started from, or null. Synchronous. */
export function bootSnapshot(): Snapshot | null {
  return boot;
}

/** Forget it in-process too, so a sign-out does not leave it seeding state. */
export function forgetBootSnapshot(): void {
  boot = null;
}
