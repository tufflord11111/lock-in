import type { Snapshot } from "./snapshot";

/**
 * When useSnapshotWriter may put its draft on disk.
 *
 * The draft starts from the snapshot this launch booted from, or from an empty
 * one, and each listener patches its own field. It used to be written on the
 * first patch of any field. After an in-app sign-out (which deletes the
 * snapshot) and a sign-in, the first answer was public/userName, and the
 * near-empty draft was saved: every later boot opened as "OPERATOR" with no
 * blocklist.
 *
 * The rule is exactly two conditions, and nothing else:
 *   1. the server has answered for config and blockedApps in this run;
 *   2. config is not missing or empty.
 * Lists are never compared. A shorter or empty list the server sent (a block
 * removed, Clear All Blocks, a friend removed) is a real change and is written.
 */
export const REQUIRED_BEFORE_WRITE = ["config", "blockedApps"] as const;

export function snapshotWritable(received: ReadonlySet<string>, next: Snapshot): boolean {
  if (!REQUIRED_BEFORE_WRITE.every((p) => received.has(p))) return false;
  // Every account has a config (useAuth recreates a missing one), so a missing
  // or empty one is never the real state worth keeping.
  return !!next.config && Object.keys(next.config).length > 0;
}

/** One run's draft, and the fields the server has answered for in this run. */
export class SnapshotDraft {
  private readonly received = new Set<string>();

  constructor(readonly snapshot: Snapshot) {}

  apply(path: string, patch: (s: Snapshot) => void): void {
    patch(this.snapshot);
    this.received.add(path);
  }

  writable(): boolean {
    return snapshotWritable(this.received, this.snapshot);
  }
}
