// The task state machine, as data. Pure: no I/O, so it can be tested exhaustively.
// db.applyEvent (db/tasks.ts) is the only thing that writes a status, and it asks this module first.
import type { TaskEventType } from './history.ts';
import type { Task } from './task.ts';

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
  | { type: 'finish'; outcome: 'done' | 'cancelled' } // a run ended
  | { type: 'finish'; outcome: 'blocked'; environment?: boolean } // environment = the environment is to blame: the attempt is given back
  | { type: 'finish'; outcome: 'failed'; retry: boolean } // a run failed; retry = attempts remain
  | { type: 'rate_limited' } // a run hit the usage limit; not the task's fault
  | { type: 'conflict' } // a done task's branch conflicts with its base and the resolve run could not fix it
  | { type: 'cancel' }
  | { type: 'approve' } // accept a planner proposal
  | { type: 'reject' } // decline a planner proposal
  | { type: 'retry' } // a human asks for another attempt
  | { type: 'mark_done' } // a person finished or landed the work themselves
  | { type: 'pr_merged' } // the daemon found the task's open PR merged on GitHub
  | { type: 'recover'; exhausted: boolean }; // the daemon restarted mid-run; exhausted = too many restarts

export type RuleKey =
  | 'claim'
  | 'finish:done'
  | 'finish:blocked'
  | 'finish:cancelled'
  | 'finish:failed'
  | 'finish:failed:retry'
  | 'rate_limited'
  | 'conflict'
  | 'cancel'
  | 'approve'
  | 'reject'
  | 'retry'
  | 'mark_done'
  | 'pr_merged'
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
  conflict: { done: 'blocked' },
  cancel: { proposed: 'cancelled', queued: 'cancelled', blocked: 'cancelled', failed: 'cancelled', running: 'cancel_requested' },
  approve: { proposed: 'queued' },
  reject: { proposed: 'cancelled' },
  retry: { blocked: 'queued', failed: 'queued', cancelled: 'queued', done: 'queued' },
  mark_done: { blocked: 'done', failed: 'done' },
  pr_merged: { blocked: 'done', failed: 'done' },
  recover: { running: 'queued', cancel_requested: 'cancelled' },
  'recover:exhausted': { running: 'failed', cancel_requested: 'cancelled' },
};

/** Every status each status may move to, read off RULES. */
export const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = Object.fromEntries(
  TASK_STATUSES.map((from) => [from, [...new Set(Object.values(RULES).flatMap((r) => (r[from] ? [r[from]] : [])))]]),
) as Record<TaskStatus, TaskStatus[]>;

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

/** The events a person can ask for. */
export type PersonEvent = 'approve' | 'reject' | 'retry' | 'cancel' | 'mark_done';
const PERSON_EVENTS: PersonEvent[] = ['approve', 'reject', 'retry', 'cancel', 'mark_done'];

/**
 * What a person may do with a task in this status. A proposal is declined with `reject`, so it
 * is never offered `cancel` (the rules would allow both).
 */
export function personEvents(t: Pick<Task, 'status'>): PersonEvent[] {
  return PERSON_EVENTS.filter((type) => canApply(t.status, { type }) && !(type === 'cancel' && t.status === 'proposed'));
}

/** Every status `event` is allowed from (for guards like `WHERE status IN (...)`). */
export function fromStatuses(event: TaskEvent): TaskStatus[] {
  return Object.keys(RULES[ruleKey(event)]) as TaskStatus[];
}

/** The fields of a task that `transition` reads. */
export type TransitionTask = Pick<Task, 'status' | 'attempts' | 'restarts'>;

/** The fields an event sets, with their new values. A field not listed is left as it is. */
export interface TaskChanges {
  attempts?: number;
  max_attempts?: number;
  restarts?: number;
  stop_reason?: string | null;
  needs?: string | null;
  done_by?: 'person' | null;
}

export interface Transition {
  to: TaskStatus;
  changes: TaskChanges;
  /** The timeline type to record: the event's, or `environment_block` for a block the environment caused. */
  history: TaskEventType;
}

/**
 * What `event` does to `task`: the status it leads to, the new value of every field it sets and the
 * history type; null if the event isn't allowed from the task's status. A cancelled outcome (the cancel
 * wins from `cancel_requested`) changes no field.
 */
export function transition(
  task: TransitionTask,
  event: TaskEvent,
  opts: { reason?: string | null; needs?: string | null } = {},
): Transition | null {
  const to = nextStatus(task.status, event);
  if (!to) return null;
  const environment = event.type === 'finish' && event.outcome === 'blocked' && event.environment === true;
  const history: TaskEventType = environment ? 'environment_block' : event.type;
  const changes: TaskChanges = {};
  if (to === 'cancelled') return { to, changes, history };

  const given = Math.max(task.attempts - 1, 0); // the attempt given back
  if (event.type === 'claim') changes.attempts = task.attempts + 1;
  else if (event.type === 'retry')
    changes.max_attempts = task.attempts + 1; // one more attempt on top of those used
  else if (event.type === 'rate_limited' || environment) changes.attempts = given;
  else if (event.type === 'recover') {
    changes.restarts = task.restarts + 1;
    if (to === 'queued') changes.attempts = given;
  }
  if ((event.type === 'finish' && event.outcome === 'done') || event.type === 'mark_done' || event.type === 'pr_merged')
    changes.stop_reason = null;
  if (event.type === 'mark_done' || event.type === 'pr_merged') changes.needs = null;
  if (event.type === 'mark_done') changes.done_by = 'person';
  else if (task.status === 'done') changes.done_by = null;
  if (to === 'queued') changes.needs = null;
  else if (event.type === 'finish' && event.outcome === 'blocked') changes.needs = opts.needs ?? null;
  if (
    (event.type === 'finish' && (event.outcome === 'blocked' || event.outcome === 'failed')) ||
    (event.type === 'recover' && to === 'failed') ||
    event.type === 'conflict'
  )
    changes.stop_reason = opts.reason ?? null;
  return { to, changes, history };
}

/** A task requeued by this many daemon restarts is failed instead, in case the task itself kills the daemon. */
export const MAX_RESTARTS = 3;
