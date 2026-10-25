// May new work start? The pause flag, the rate limit and the governor's decision, read once.
import type { Db } from '../../db/index.ts';
import { decide } from '../../domain/usage/governor.ts';
import type { QueueState } from '../../domain/task/start.ts';

/** The state that decides whether work may start. `rate_limited_until` is null once it has lifted or was never set. */
export function startGate(db: Db): QueueState {
  return {
    paused: db.isPaused(),
    rate_limited_until: db.rateLimitedUntil(),
    governor: decide(db.usageWindows(), db.budget(), db.maxConcurrent()),
  };
}
