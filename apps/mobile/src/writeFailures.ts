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
export type WriteFailure = { id: number; message: string; at: number };

type Listener = (failure: WriteFailure) => void;

const listeners = new Set<Listener>();
let nextId = 1;

/** Report a failed background write. Safe to call from anywhere, never throws. */
export function reportWriteFailure(message: string, err?: unknown): void {
  console.error(`[LOCK-IN] write failed — ${message}`, err);
  const failure: WriteFailure = { id: nextId++, message, at: Date.now() };
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
