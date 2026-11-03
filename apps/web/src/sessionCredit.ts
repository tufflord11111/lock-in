/**
 * Minutes a session earns: the time it ran, less the time the PC was asleep.
 * Rounds up, as sessions always have, so a session cut short keeps its last
 * partial minute. Slept right through, it earns nothing.
 */
export function creditedMinutes(secondsSpent: number, asleepMs: number): number {
  return Math.ceil(Math.max(0, secondsSpent - asleepMs / 1000) / 60);
}
