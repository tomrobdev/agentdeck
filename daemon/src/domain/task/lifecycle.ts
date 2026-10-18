// The task state machine, as data. Pure: no I/O, so it can be tested exhaustively.
// db.applyEvent (db/tasks.ts) is the only thing that writes a status, and it asks this module first.

export type TaskStatus =
  | 'proposed' // suggested by the planner, waiting for approval
  | 'queued'
  | 'running'
  | 'done'
  | 'blocked'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled';

export const TASK_STATUSES: TaskStatus[] = ['proposed', 'queued', 'running', 'done', 'blocked', 'failed', 'cancel_requested', 'cancelled'];

/** What happened to a task. Everything that changes a status is one of these. */
export type TaskEvent =
  | { type: 'claim' } // the scheduler picked it up
  | { type: 'finish'; outcome: 'done' | 'blocked' | 'cancelled' } // a run ended
  | { type: 'finish'; outcome: 'failed'; retry: boolean } // a run failed; retry = attempts remain
  | { type: 'rate_limited' } // a run hit the usage limit; not the task's fault
  | { type: 'cancel' }
  | { type: 'approve' } // accept a planner proposal
  | { type: 'reject' } // decline a planner proposal
  | { type: 'retry' } // a human asks for another attempt
  | { type: 'recover'; exhausted: boolean }; // the daemon restarted mid-run; exhausted = too many restarts

/** Every status each status may move to. `nextStatus` results are always listed here. */
export const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  proposed: ['queued', 'cancelled'],
  queued: ['running', 'cancelled'],
  running: ['queued', 'done', 'blocked', 'failed', 'cancel_requested', 'cancelled'],
  cancel_requested: ['cancelled'],
  done: ['queued'],
  blocked: ['queued', 'cancelled'],
  failed: ['queued', 'cancelled'],
  cancelled: ['queued'],
};

export type RuleKey =
  | 'claim'
  | 'finish:done'
  | 'finish:blocked'
  | 'finish:cancelled'
  | 'finish:failed'
  | 'finish:failed:retry'
  | 'rate_limited'
  | 'cancel'
  | 'approve'
  | 'reject'
  | 'retry'
  | 'recover'
  | 'recover:exhausted';

/**
 * event → current status → next status. A missing entry means the event is refused.
 *
 * When a run ends after cancel was requested, the cancel wins: whatever the outcome (done, failed,
 * rate limited, even a daemon restart), a 'cancel_requested' task ends 'cancelled'. The user asked
 * for it to stop, so it must not turn up as 'done' or get requeued. The run record keeps its real
 * outcome and any commits stay on the task's branch.
 */
export const RULES: Record<RuleKey, Partial<Record<TaskStatus, TaskStatus>>> = {
  claim: { queued: 'running' },
  'finish:done': { running: 'done', cancel_requested: 'cancelled' },
  'finish:blocked': { running: 'blocked', cancel_requested: 'cancelled' },
  'finish:cancelled': { running: 'cancelled', cancel_requested: 'cancelled' },
  'finish:failed': { running: 'failed', cancel_requested: 'cancelled' },
  'finish:failed:retry': { running: 'queued', cancel_requested: 'cancelled' },
  rate_limited: { running: 'queued', cancel_requested: 'cancelled' },
  cancel: { proposed: 'cancelled', queued: 'cancelled', blocked: 'cancelled', failed: 'cancelled', running: 'cancel_requested' },
  approve: { proposed: 'queued' },
  reject: { proposed: 'cancelled' },
  retry: { blocked: 'queued', failed: 'queued', cancelled: 'queued', done: 'queued' },
  recover: { running: 'queued', cancel_requested: 'cancelled' },
  'recover:exhausted': { running: 'failed', cancel_requested: 'cancelled' },
};

export function ruleKey(e: TaskEvent): RuleKey {
  switch (e.type) {
    case 'finish':
      return e.outcome === 'failed' ? (e.retry ? 'finish:failed:retry' : 'finish:failed') : `finish:${e.outcome}`;
    case 'recover':
      return e.exhausted ? 'recover:exhausted' : 'recover';
    default:
      return e.type;
  }
}

/** The status `event` leads to from `from`, or undefined if the event isn't allowed there. */
export function nextStatus(from: TaskStatus, event: TaskEvent): TaskStatus | undefined {
  return RULES[ruleKey(event)][from];
}

export function canApply(from: TaskStatus, event: TaskEvent): boolean {
  return nextStatus(from, event) !== undefined;
}

/** Every status `event` is allowed from (for guards like `WHERE status IN (...)`). */
export function fromStatuses(event: TaskEvent): TaskStatus[] {
  return Object.keys(RULES[ruleKey(event)]) as TaskStatus[];
}

/** A task requeued by this many daemon restarts is failed instead, in case the task itself kills the daemon. */
export const MAX_RESTARTS = 3;
