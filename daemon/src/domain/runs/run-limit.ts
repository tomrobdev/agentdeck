// The two limits on a claude process, stall and total, counted in time awake rather than wall-clock time.

/** Which limit stopped a run: `stall` when claude printed no line for too long, `total` when it ran too long in all. */
export type RunLimit = 'stall' | 'total';

/** The limits on one claude process, and how often they are checked; all in milliseconds. */
export interface RunLimits {
  stallMs: number;
  maxMs: number;
  checkMs: number;
}

/** A run's time so far: when it was last looked at, how long since its last line, and how long in all. */
export interface RunClock {
  at: number;
  quietMs: number;
  totalMs: number;
}

/** A run a limit stopped: which one, and what it was. */
export interface LimitStop {
  limit: RunLimit;
  ms: number;
}

const COUNTED_CHECKS = 3;

export const startClock = (now: number): RunClock => ({ at: now, quietMs: 0, totalMs: 0 });

export function advanceClock(clock: RunClock, now: number, limits: RunLimits): RunClock {
  const step = Math.min(Math.max(now - clock.at, 0), limits.checkMs * COUNTED_CHECKS);
  return { at: now, quietMs: clock.quietMs + step, totalMs: clock.totalMs + step };
}

export const heardLine = (clock: RunClock, now: number, limits: RunLimits): RunClock => ({
  ...advanceClock(clock, now, limits),
  quietMs: 0,
});

export function limitReached(clock: RunClock, limits: RunLimits): LimitStop | null {
  if (clock.totalMs >= limits.maxMs) return { limit: 'total', ms: limits.maxMs };
  if (clock.quietMs >= limits.stallMs) return { limit: 'stall', ms: limits.stallMs };
  return null;
}

const duration = (ms: number): string => {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} min`;
  return ms >= 1_000 && ms % 1_000 === 0 ? `${ms / 1_000} s` : `${ms} ms`;
};

export function limitReason(stop: LimitStop): string {
  return stop.limit === 'stall'
    ? `stall limit: claude printed nothing for ${duration(stop.ms)}`
    : `total limit: claude ran for ${duration(stop.ms)}`;
}
