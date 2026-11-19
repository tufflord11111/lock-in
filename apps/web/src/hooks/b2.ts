/**
 * 1.3.1 B2 (privacy and Web Guard trust): the pure parts, so they can be tested
 * without Firebase. The rules these mirror are in database.rules.json.
 */

/** Stamped on every session this build starts. Web Guard and the rules hold these to their end. */
export const SESSION_GUARD = 2;
/** The rules let a guarded session end this long before its endTime (clock skew). */
export const END_GRACE_MS = 120_000;
const RETRY_PAD_MS = 2_000;
const MAX_RETRY_WAIT_MS = 6 * 60_000;

export const DELETE_DURING_SESSION = "Finish or bail out of your session before deleting your account.";
export const VERIFY_FIRST = "Verify your email to add friends or change your handle.";
export const PACK_TEXT = {
  waiting: "Waiting for them to add you back.",
  request: (name: string) => `${name} added you. Add back?`,
  addBack: "Add back",
  dismiss: "Dismiss",
};

type SessionNode = { isActive?: unknown; guard?: unknown; endTime?: unknown; bailoutEnd?: unknown } | null | undefined;

export function isPermissionDenied(err: unknown): boolean {
  const code = String((err as { code?: string })?.code ?? "");
  const message = String((err as { message?: string })?.message ?? "");
  return /permission[_ ]denied/i.test(code) || /permission[_ ]denied/i.test(message);
}

/** Does the server still hold this session (the rules refuse its end)? Mirrors the rules. */
export function guardedSessionLive(s: SessionNode, serverNow: number): boolean {
  if (!s || s.guard !== SESSION_GUARD || s.isActive !== true || typeof s.endTime !== "number") return false;
  if (s.endTime <= serverNow + END_GRACE_MS) return false;
  return !(typeof s.bailoutEnd === "number" && s.bailoutEnd <= serverNow);
}

/** How long to wait before retrying a refused end: until the rules will take it, plus a little. */
export function endRetryDelayMs(s: SessionNode, serverNow: number): number {
  if (!guardedSessionLive(s, serverNow)) return RETRY_PAD_MS;
  const byEnd = (s!.endTime as number) - END_GRACE_MS;
  const allowedAt = typeof s!.bailoutEnd === "number" ? Math.min(byEnd, s!.bailoutEnd) : byEnd;
  return Math.min(MAX_RETRY_WAIT_MS, Math.max(0, allowedAt - serverNow) + RETRY_PAD_MS);
}

/**
 * A session-end write, retried once if the rules refuse it (a clock a little
 * ahead of the server's). Rejects with the second error, so the caller's
 * message appears only when the retry fails too.
 */
export async function endWithOneRetry(
  write: () => Promise<void>,
  readSession: () => Promise<SessionNode>,
  serverNow: () => number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<void> {
  try {
    await write();
  } catch (err) {
    if (!isPermissionDenied(err)) throw err;
    const s = await readSession().catch(() => null);
    await sleep(endRetryDelayMs(s, serverNow()));
    await write();
  }
}

/** The fuse's end in server time, from Rust's local deadline and the server clock offset. */
export function bailoutEndFor(localDeadline: number, serverOffsetMs: number): number {
  return localDeadline + serverOffsetMs;
}

/** The request that tells `to` that `from` added them. Sent after from's own friends entry. */
export function friendRequestWrite(from: string, to: string): { path: string; from: string } {
  return { path: `friendRequests/${to}/${from}`, from };
}

/**
 * Delete account's clean-up, before the account itself goes: out of the lists
 * of everyone this account added, its requests to them, and requests to it.
 * Someone who added this account one-way can't be found (no reverse index).
 */
export function deleteCleanupUpdates(uid: string, friendUids: string[]): Record<string, null> {
  const out: Record<string, null> = {};
  for (const f of friendUids) out[`users/${f}/friends/${uid}`] = null;
  for (const f of friendUids) out[`friendRequests/${f}/${uid}`] = null;
  out[`friendRequests/${uid}`] = null;
  return out;
}

const PUBLIC_NAME = /^[A-Za-z0-9_]{1,20}$/;

/** What friends see: the name if it is handle-shaped, else the handle upper-cased, else nothing. */
export function publicNameToWrite(name: unknown, handle: unknown): string | null {
  if (typeof name === "string" && PUBLIC_NAME.test(name)) return name;
  if (typeof handle === "string" && PUBLIC_NAME.test(handle)) return handle.toUpperCase();
  return null;
}

/** The invite: a link and a handle to add, never a uid. */
export function inviteText(handle: string | null): string {
  const add = handle ? ` Then add me in The Pack: ${handle}` : "";
  return ` Join me on Lock-In — the hardcore focus vault for Windows.\n\nDownload: https://lockinme.com${add}`;
}
