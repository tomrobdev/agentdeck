// What a queued task waits for, in the order the scheduler checks. Pure: no I/O.
import type { TaskId } from '../../shared/index.ts';
import type { Decision } from '../../capacity/index.ts';
import type { TaskStatus } from '../lifecycle/lifecycle.ts';
import type { StartState } from '../links/link.ts';

/** What every queued task waits for: the daemon is paused, Claude rate-limited us, or the governor holds. */
export type QueueWait =
  { kind: 'daemon-paused' } | { kind: 'rate-limited'; until: number } | { kind: 'governor'; reason: string; until: number | null };

/** What a queued task that builds on others is waiting for, or null if it isn't waiting. */
export interface Waiting {
  /** Every task it builds on that is still on its way; or, when stuck, the one root it is stuck on. */
  on: TaskId[];
  /** Set when what it waits for won't get there on its own; null while it is on its way. */
  stuck: string | null;
}

/** What a start state leaves a task waiting for on its builds-on links, or null when it waits for none of them. */
export function waitingOf(state: StartState): Waiting | null {
  if (state.kind === 'waiting') return { on: state.on, stuck: null };
  if (state.kind === 'stuck') return { on: [state.on], stuck: state.reason };
  return null;
}

/** What one queued task waits for. A task that waits for nothing starts on the scheduler's next tick. */
export type StartWait =
  | QueueWait
  | { kind: 'repo-paused'; reason: string }
  | ({ kind: 'dependency' } & Waiting)
  | { kind: 'unblocking' }
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

/** Only a queued task waits to start: any other has started, or is not to start. */
const waitsToStart = (task: { status: TaskStatus }): boolean => task.status === 'queued';

/** What a queued task in start state `dependency` waits for on its builds-on links; null for any other task. */
export function waitingFor(task: { status: TaskStatus }, dependency: StartState): Waiting | null {
  return waitsToStart(task) ? waitingOf(dependency) : null;
}

/**
 * What a queued task waits for, or null if it will start on the next tick. Mirrors `claimable` in db/work/tasks-status.ts, which leaves
 * out the slots: the scheduler counts those. `unblocking`: an unblock run for the task is still going (a person retried it
 * meanwhile), and the task waits for that run to stop.
 */
export function startWait(
  task: { status: TaskStatus },
  ctx: {
    queue: QueueWait | null;
    repoPaused: string | null;
    dependency: StartState;
    unblocking: boolean;
    running: number;
    max: number;
  },
): StartWait | null {
  if (!waitsToStart(task)) return null;
  if (ctx.queue) return ctx.queue;
  if (ctx.repoPaused) return { kind: 'repo-paused', reason: ctx.repoPaused };
  const waiting = waitingOf(ctx.dependency);
  if (waiting) return { kind: 'dependency', ...waiting };
  if (ctx.unblocking) return { kind: 'unblocking' };
  if (ctx.running >= ctx.max) return { kind: 'slots', running: ctx.running, max: ctx.max };
  return null;
}
