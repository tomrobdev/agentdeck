// May new work start? The pause flag, the rate limit and the governor's decision, read once.
import type { App } from '#application/ports/app.ts';
import { decide } from '#domain/capacity/index.ts';
import { type QueueState, type QueueWait, startDecision } from '#domain/work/index.ts';

export function startGate(app: App): QueueState {
  return {
    paused: app.isPaused(),
    rate_limited_until: app.rateLimitedUntil(),
    governor: decide(app.usageWindows(), app.budget(), app.maxConcurrent(), Date.now() / 1000),
  };
}

export function queueWait(app: App, ignorePause = false): { wait: QueueWait | null; free: number; used: number; max: number } {
  const gate = startGate(app);
  const used = app.slotsUsed();
  return { ...startDecision(gate, { ignorePause, used, now: Date.now() / 1000 }), used, max: gate.governor.max_concurrent };
}
