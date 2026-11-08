// May new work start? The pause flag, the rate limit and the governor's decision, read once.
import type { Repositories as Db } from '../ports/repositories.ts';
import { decide } from '../../domain/capacity/index.ts';
import { type QueueState, type QueueWait, startDecision } from '../../domain/work/index.ts';

/** The state that decides whether work may start. `rate_limited_until` is null once it has lifted or was never set. */
export function startGate(db: Db): QueueState {
  return {
    paused: db.isPaused(),
    rate_limited_until: db.rateLimitedUntil(),
    governor: decide(db.usageWindows(), db.budget(), db.maxConcurrent()),
  };
}

/**
 * What the whole queue waits for now (startDecision over startGate), with the slots: `used` (in use), `max` (the
 * governor's max_concurrent) and `free`. `ignorePause` is run-once's, which works through a paused queue.
 */
export function queueWait(db: Db, ignorePause = false): { wait: QueueWait | null; free: number; used: number; max: number } {
  const gate = startGate(db);
  const used = db.slotsUsed();
  return { ...startDecision(gate, { ignorePause, used, now: Date.now() / 1000 }), used, max: gate.governor.max_concurrent };
}
