/**
 * One visible channel for background write failures. Mirror of the desktop's
 * apps/web/src/writeFailures.ts, kept local so the mobile bundle does not pull
 * in the desktop UI package.
 *
 * Several Firebase writes are deliberately fire-and-forget so the UI never
 * blocks on the network. On mobile these previously used a bare
 * `.catch(() => {})`, which discarded the error entirely: session history and
 * streak minutes could fail with no trace at all.
 *
 * Messages must name WHAT was lost, not "an error occurred".
 */

/**
 * "error" — a write was refused or failed; something did not save.
 * "info"  — nothing has failed yet, but the operator needs to know (a write
 *           queued offline). Rendered calmly, not logged as a failure.
 */
export type WriteFailureKind = "info" | "error";

export type WriteFailure = {
  id: number;
  message: string;
  at: number;
  kind: WriteFailureKind;
  /** Never auto-dismissed; cleared by the operator or dismissWriteFailure. */
  sticky: boolean;
};

type Listener = (failure: WriteFailure) => void;
type DismissListener = (id: number) => void;

const listeners = new Set<Listener>();
const dismissListeners = new Set<DismissListener>();
let nextId = 1;

/**
 * Report a failed background write. Safe to call from anywhere, never throws.
 * Returns the toast's id, for dismissWriteFailure.
 */
export function reportWriteFailure(
  message: string,
  err?: unknown,
  kind: WriteFailureKind = "error",
  options: { sticky?: boolean } = {}
): number {
  if (kind === "error") {
    console.error(`[LOCK-IN] write failed — ${message}`, err);
  } else {
    console.info(`[LOCK-IN] ${message}`);
  }
  const failure: WriteFailure = {
    id: nextId++,
    message,
    at: Date.now(),
    kind,
    sticky: options.sticky === true,
  };
  for (const listener of listeners) {
    try {
      listener(failure);
    } catch {
      /* a broken listener must never break the caller's write path */
    }
  }
  return failure.id;
}

/** Remove a toast wherever it is showing. */
export function dismissWriteFailure(id: number): void {
  for (const listener of dismissListeners) {
    try {
      listener(id);
    } catch {
      /* never break the dismisser */
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

/** Subscribe to dismissals. Returns an unsubscribe function. */
export function onWriteFailureDismissed(listener: DismissListener): () => void {
  dismissListeners.add(listener);
  return () => {
    dismissListeners.delete(listener);
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
