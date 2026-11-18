// What a queued task waits for, in the order the scheduler checks.
import type { TaskId } from '#domain/shared/index.ts';
import type { Decision } from '#domain/capacity/index.ts';
import type { TaskStatus } from '#domain/work/lifecycle/lifecycle.ts';
import type { StartState } from '#domain/work/links/link.ts';

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

export function waitingOf(state: StartState): Waiting | null {
  if (state.kind === 'waiting') return { on: state.on, stuck: null };
  if (state.kind === 'stuck') return { on: [state.on], stuck: state.reason };
  return null;
}

/** What one queued task waits for. A task that waits for nothing starts on the scheduler's next tick. */
export type StartWait =
  | QueueWait
  | { kind: 'repo-paused'; reason: string }
  | { kind: 'draining'; repo: boolean }
  | ({ kind: 'dependency' } & Waiting)
  | { kind: 'unblocking' }
  | { kind: 'slots'; running: number; max: number };

export interface QueueState {
  paused: boolean;
  /** Unix seconds; in the past (or null) once the rate limit has lifted. */
  rate_limited_until: number | null;
  governor: Decision;
}

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

const waitsToStart = (task: { status: TaskStatus }): boolean => task.status === 'queued';

export function waitingFor(task: { status: TaskStatus }, dependency: StartState): Waiting | null {
  return waitsToStart(task) ? waitingOf(dependency) : null;
}

export function startWait(
  task: { status: TaskStatus },
  ctx: {
    queue: QueueWait | null;
    repoPaused: string | null;
    draining: 'daemon' | 'repo' | null;
    dependency: StartState;
    unblocking: boolean;
    running: number;
    max: number;
  },
): StartWait | null {
  if (!waitsToStart(task)) return null;
  if (ctx.queue) return ctx.queue;
  if (ctx.repoPaused) return { kind: 'repo-paused', reason: ctx.repoPaused };
  if (ctx.draining) return { kind: 'draining', repo: ctx.draining === 'repo' };
  const waiting = waitingOf(ctx.dependency);
  if (waiting) return { kind: 'dependency', ...waiting };
  if (ctx.unblocking) return { kind: 'unblocking' };
  if (ctx.running >= ctx.max) return { kind: 'slots', running: ctx.running, max: ctx.max };
  return null;
}
