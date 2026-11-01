// What a queued task waits for, in the order the scheduler checks. Pure: no I/O.
import type { Decision } from '../usage/governor.ts';
import type { StartState } from './link.ts';

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

/**
 * May new work start, and how many slots are free? The one place this is decided: the scheduler, the sync of a done
 * task's conflicting PR and the API's queue view all call it. `ignorePause` is run-once, which works through a paused
 * queue. `used` is the slots in use (running tasks, open resolve runs and planner runs: the planner takes a slot);
 * `free` is what is left of the governor's `max_concurrent`, and 0 whenever something is waited for.
 */
export function startDecision(
  q: QueueState,
  o: { ignorePause: boolean; used: number; now: number },
): { wait: QueueWait | null; free: number } {
  const { now } = o;
  let wait: QueueWait | null = null;
  if (q.paused && !o.ignorePause) wait = { kind: 'daemon-paused' };
  else if (q.rate_limited_until && q.rate_limited_until > now) wait = { kind: 'rate-limited', until: q.rate_limited_until };
  else if (!q.governor.allow) wait = { kind: 'governor', reason: q.governor.reason ?? 'usage budget', until: q.governor.until };
  return { wait, free: wait ? 0 : Math.max(0, q.governor.max_concurrent - o.used) };
}

/** The line the daemon logs for a wait. */
export function describeWait(w: QueueWait): string {
  switch (w.kind) {
    case 'daemon-paused':
      return 'paused';
    case 'rate-limited':
      return `rate limited until ${new Date(w.until * 1000).toLocaleTimeString()}`;
    case 'governor':
      return w.reason;
  }
}

/** What a queued task waits for, or null if it will start on the next tick. Mirrors claimNextTask in db/tasks.ts. */
export function startWait(
  task: { status: string },
  ctx: {
    queue: QueueWait | null;
    repoPaused: string | null;
    dependency: StartState;
    running: number;
    max: number;
  },
): StartWait | null {
  if (task.status !== 'queued') return null;
  if (ctx.queue) return ctx.queue;
  if (ctx.repoPaused) return { kind: 'repo-paused', reason: ctx.repoPaused };
  const dep = ctx.dependency;
  if (dep.kind === 'waiting' || dep.kind === 'stuck')
    return { kind: 'dependency', on: dep.kind === 'waiting' ? dep.on[0] : dep.on, stuck: dep.kind === 'stuck' ? dep.reason : null };
  if (ctx.running >= ctx.max) return { kind: 'slots', running: ctx.running, max: ctx.max };
  return null;
}
