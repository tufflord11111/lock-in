// Mirror of apps/web/src/offlineWrite.ts (mobile keeps its own writeFailures).
import { dismissWriteFailure, reportWriteFailure } from "./writeFailures";

/** How long a handler may wait on a write before carrying on locally. */
export const WRITE_ACK_MS = 5000;

export const SAVED_LOCALLY = "Saved locally — will sync when you're back online.";

export type WriteOutcome = "acked" | "queued";

/**
 * Wait for a Firebase write, but never for more than 5 s.
 *
 * Offline, a write neither resolves nor rejects: the SDK queues it and leaves
 * the promise pending until the connection returns. A handler that simply
 * awaited it left its button spinning forever with nothing on screen. This
 * resolves one of three ways:
 *
 *  - acknowledged within 5 s → "acked"
 *  - refused within 5 s       → rejects; the caller shows its own error
 *  - neither                  → "queued": the caller proceeds as if saved, a
 *                               sticky info toast says so, and it clears
 *                               itself when the write is finally acknowledged.
 *                               A refusal after that point is reported via
 *                               onLateError, or as an error toast.
 *
 * The write itself is never cancelled — it stays queued in the SDK.
 */
export function awaitWriteOrQueue(
  write: PromiseLike<unknown>,
  options: { lateErrorMessage: string; onLateError?: (err: unknown) => void }
): Promise<WriteOutcome> {
  return new Promise<WriteOutcome>((resolve, reject) => {
    let settled = false;
    let queued = false;
    let toastId: number | null = null;

    const timer = setTimeout(() => {
      if (settled) return;
      queued = true;
      toastId = reportWriteFailure(SAVED_LOCALLY, undefined, "info", { sticky: true });
      resolve("queued");
    }, WRITE_ACK_MS);

    Promise.resolve(write).then(
      () => {
        settled = true;
        clearTimeout(timer);
        if (toastId !== null) dismissWriteFailure(toastId);
        if (!queued) resolve("acked");
      },
      (err) => {
        settled = true;
        clearTimeout(timer);
        if (toastId !== null) dismissWriteFailure(toastId);
        if (!queued) {
          reject(err);
        } else if (options.onLateError) {
          options.onLateError(err);
        } else {
          reportWriteFailure(options.lateErrorMessage, err);
        }
      }
    );
  });
}
