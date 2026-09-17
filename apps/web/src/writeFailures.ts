/**
 * One visible channel for background write failures.
 *
 * Several Firebase writes are deliberately fire-and-forget so the UI never
 * blocks on the network. That is correct, but it used to mean a failed write
 * vanished into a console log nobody reads: your minutes silently did not
 * record, your streak silently did not count. This makes those failures
 * visible without making them blocking.
 *
 * Messages must name WHAT was lost and what it means. "Your session minutes
 * didn't save, so your streak won't count this session" is actionable.
 * "An error occurred" is not.
 */
/**
 * "error" — a write was refused or failed; something did not save.
 * "info"  — nothing has failed yet, but the operator needs to know (e.g. a
 *           write is queued offline). Rendered calmly, not logged as a failure.
 */
export type WriteFailureKind = "info" | "error";

export type WriteFailure = {
  id: number;
  message: string;
  at: number;
  kind: WriteFailureKind;
};

type Listener = (failure: WriteFailure) => void;

const listeners = new Set<Listener>();
let nextId = 1;

/**
 * Failures reported in the last few seconds, replayed to a toast host that
 * mounts just after one.
 *
 * Some failures are reported by code that then tears the toast host down — the
 * account-delete fallback signs out, which swaps the whole app back to Login.
 * Without this the operator is told nothing at exactly the moment the message
 * matters most.
 */
const REPLAY_WINDOW_MS = 12000;
const recent: WriteFailure[] = [];

function pruneRecent(): void {
  const cutoff = Date.now() - REPLAY_WINDOW_MS;
  while (recent.length > 0 && recent[0].at < cutoff) recent.shift();
}

/** Failures still inside the replay window, oldest first. */
export function recentWriteFailures(): WriteFailure[] {
  pruneRecent();
  return [...recent];
}

/** Report a failed background write. Safe to call from anywhere, never throws. */
export function reportWriteFailure(
  message: string,
  err?: unknown,
  kind: WriteFailureKind = "error"
): void {
  if (kind === "error") {
    console.error(`[LOCK-IN] write failed — ${message}`, err);
  } else {
    console.info(`[LOCK-IN] ${message}`);
  }
  const failure: WriteFailure = { id: nextId++, message, at: Date.now(), kind };
  pruneRecent();
  recent.push(failure);
  for (const listener of listeners) {
    try {
      listener(failure);
    } catch {
      /* a broken listener must never break the caller's write path */
    }
  }
}

/** Subscribe to failures. Returns an unsubscribe function. */
export function onWriteFailure(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Wrap a fire-and-forget write so its failure surfaces. Resolves either way,
 * so callers stay non-blocking and never need their own catch.
 */
export function guardWrite<T>(
  promise: PromiseLike<T>,
  message: string
): Promise<T | undefined> {
  // PromiseLike, not Promise: Firebase's push() returns a ThenableReference,
  // which is thenable but lacks finally/Symbol.toStringTag. Promise.resolve
  // adopts either shape.
  return Promise.resolve(promise).catch((err) => {
    reportWriteFailure(message, err);
    return undefined;
  });
}
