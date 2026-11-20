// May new work start? The pause flag, the rate limit and the governor's decision, read once.
import type { App } from '#application/ports/app.ts';
import { decide, slotUse } from '#domain/capacity/index.ts';
import { type QueueState, type QueueWait, startDecision } from '#domain/work/index.ts';

export function startGate(app: App): QueueState {
  return {
    paused: app.isPaused(),
    rate_limited_until: app.rateLimitedUntil(),
    governor: decide(app.usageWindows(), app.budget(), app.maxConcurrent(), Date.now() / 1000),
  };
}

export interface QueueRoom {
  wait: QueueWait | null;
  free: number;
  support_free: number;
  used: number;
  max: number;
}

export function queueWait(app: App, ignorePause = false): QueueRoom {
  const gate = startGate(app);
  const { work, support_free } = slotUse({ used: app.slotsUsed(), support: app.supportRunsUsed(), support_slots: app.supportSlots() });
  const { wait, free } = startDecision(gate, { ignorePause, used: work, now: Date.now() / 1000 });
  return { wait, free, support_free: wait ? 0 : free + support_free, used: work, max: gate.governor.max_concurrent };
}
