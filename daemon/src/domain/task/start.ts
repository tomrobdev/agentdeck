// What a queued task waits for, in the order the scheduler checks. Pure: no I/O.
import type { Decision } from '../usage/governor.ts';
import type { DependencyState } from './dependency.ts';

/** What every queued task waits for: the daemon is paused, Claude rate-limited us, or the governor holds. */
export type QueueWait =
  { kind: 'daemon-paused' } | { kind: 'rate-limited'; until: number } | { kind: 'governor'; reason: string; until: number | null };

/** What one queued task waits for. A task that waits for nothing starts on the scheduler's next tick. */
export type StartWait =
  | QueueWait
  | { kind: 'repo-paused'; reason: string }
  | { kind: 'dependency'; on: number; stuck: string | null }
  | { kind: 'slots'; running: number; max: number };

export interface QueueState {
  paused: boolean;
  /** Unix seconds; in the past (or null) once the rate limit has lifted. */
  rate_limited_until: number | null;
  governor: Decision;
}

/** Mirrors the scheduler's gate, except that `paused` is whatever the caller says (run-once ignores it). */
export function queueWait(q: QueueState, now = Date.now() / 1000): QueueWait | null {
  if (q.paused) return { kind: 'daemon-paused' };
  if (q.rate_limited_until && q.rate_limited_until > now) return { kind: 'rate-limited', until: q.rate_limited_until };
  if (!q.governor.allow) return { kind: 'governor', reason: q.governor.reason ?? 'usage budget', until: q.governor.until };
  return null;
}

/** What a queued task waits for, or null if it will start on the next tick. Mirrors claimNextTask in db/tasks.ts. */
export function startWait(
  task: { status: string },
  ctx: {
    queue: QueueWait | null;
    repoPaused: string | null;
    dependency: DependencyState;
    after: number | null;
    running: number;
    max: number;
  },
): StartWait | null {
  if (task.status !== 'queued') return null;
  if (ctx.queue) return ctx.queue;
  if (ctx.repoPaused) return { kind: 'repo-paused', reason: ctx.repoPaused };
  const dep = ctx.dependency;
  if (ctx.after !== null && (dep.kind === 'waiting' || dep.kind === 'stuck'))
    return { kind: 'dependency', on: ctx.after, stuck: dep.kind === 'stuck' ? dep.reason : null };
  if (ctx.running >= ctx.max) return { kind: 'slots', running: ctx.running, max: ctx.max };
  return null;
}
