/**
 * Safety net for a wedged Realtime Database connection.
 *
 * If .info/connected has been false for STUCK_MS while useReachable says the
 * database host answers, the connection is stuck rather than offline. The
 * hook then cycles the connection (goOffline/goOnline) and forces a fresh ID
 * token, at most once per MIN_GAP_MS. A host that doesn't answer is real
 * offline: the count restarts, so the first STUCK_MS is always online time.
 */
export const STUCK_MS = 60_000;
export const MIN_GAP_MS = 5 * 60_000;
/** How often the hook evaluates; the kick lands between STUCK_MS and STUCK_MS + CHECK_MS. */
export const CHECK_MS = 5_000;

export type WatchdogState = {
  /** When the current stretch of "host answers, database not connected" began. */
  stuckSince: number | null;
  lastKickAt: number | null;
};

export const WATCHDOG_START: WatchdogState = { stuckSince: null, lastKickAt: null };

export function watchdogStep(
  state: WatchdogState,
  input: { connected: boolean; hostAnswers: boolean; now: number }
): { state: WatchdogState; kick: boolean } {
  const { connected, hostAnswers, now } = input;
  if (connected || !hostAnswers) return { state: { ...state, stuckSince: null }, kick: false };
  const stuckSince = state.stuckSince ?? now;
  const due = now - stuckSince >= STUCK_MS;
  const gapOk = state.lastKickAt === null || now - state.lastKickAt >= MIN_GAP_MS;
  if (due && gapOk) return { state: { stuckSince: now, lastKickAt: now }, kick: true };
  return { state: { ...state, stuckSince }, kick: false };
}
