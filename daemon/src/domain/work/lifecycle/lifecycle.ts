// The task state machine, as data. Pure: no I/O, so it can be tested exhaustively.
// applyEvent (db/work/tasks-status.ts) is the only thing that writes a status, and it asks this module first.
import type { TaskId } from '../../shared/index.ts';
import type { PullRequest } from '../../landing/index.ts';
import type { TaskEventType } from './history.ts';
import type { Needs } from '../task/needs.ts';
import { type TaskCore, type TaskState, attemptsLeft, stopReasonOf } from '../task/task.ts';
import { type TaskChanges, statusChangePrChanges } from './task-writes.ts';

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
  | { type: 'finish'; outcome: 'failed'; retry?: false } // a run failed: requeued while attempts remain (`attemptsLeft`), unless retry is false (the worker crashed)
  | { type: 'rate_limited' } // a run hit the usage limit; not the task's fault
  | { type: 'conflict' } // a done task's branch conflicts with its base and the resolve run could not fix it
  | { type: 'cancel' }
  | { type: 'approve' } // accept a planner proposal
  | { type: 'reject' } // decline a planner proposal
  | { type: 'retry' } // a human asks for another attempt
  | { type: 'unblock_retry' } // an unblock run sent a blocked task back with a note; its attempts stay as they are
  | { type: 'review_retry' } // a review run asked for changes to a done task; one attempt is added, as a person's retry adds
  | { type: 'mark_done' } // a person finished or landed the work themselves
  | { type: 'pr_merged' } // the daemon found the task's open PR merged on GitHub
  | { type: 'recover' }; // the daemon restarted mid-run; one restart too many (`restartsExhausted`) fails the task

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
  | 'unblock_retry'
  | 'review_retry'
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
  unblock_retry: { blocked: 'queued' },
  review_retry: { done: 'queued' },
  mark_done: { blocked: 'done', failed: 'done' },
  pr_merged: { blocked: 'done', failed: 'done' },
  recover: { running: 'queued', cancel_requested: 'cancelled' },
  'recover:exhausted': { running: 'failed', cancel_requested: 'cancelled' },
};

/**
 * The counters of a task that choose between an event's rules: its restarts so far, which decide whether a recover is one
 * too many, and its attempts, which decide whether a failed run is requeued. A counter left out counts as 0.
 */
export type RuleCounters = Partial<Pick<TaskCore, 'restarts' | 'attempts' | 'max_attempts'>>;

/** The rule `e` follows for a task with `counters`. */
export function ruleKey(e: TaskEvent, counters: RuleCounters = {}): RuleKey {
  switch (e.type) {
    case 'finish':
      if (e.outcome !== 'failed') return `finish:${e.outcome}`;
      return e.retry !== false && attemptsLeft({ attempts: counters.attempts ?? 0, max_attempts: counters.max_attempts ?? 0 })
        ? 'finish:failed:retry'
        : 'finish:failed';
    case 'recover':
      return restartsExhausted(counters.restarts ?? 0) ? 'recover:exhausted' : 'recover';
    default:
      return e.type;
  }
}

/** The status `event` leads to from `from` for a task with `counters`, or undefined if the event isn't allowed there. */
export function nextStatus(from: TaskStatus, event: TaskEvent, counters: RuleCounters = {}): TaskStatus | undefined {
  return RULES[ruleKey(event, counters)][from];
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
export function personEvents(t: { status: TaskStatus }): PersonEvent[] {
  return PERSON_EVENTS.filter((type) => canApply(t.status, { type }) && !(type === 'cancel' && t.status === 'proposed'));
}

/** Every status `event` is allowed from (for guards like `WHERE status IN (...)`). An event's rules share their from statuses. */
export function fromStatuses(event: TaskEvent): TaskStatus[] {
  return Object.keys(RULES[ruleKey(event)]) as TaskStatus[];
}

/**
 * What a status change says happened, read by its follow-ups (`FOLLOW_UPS` in follow-ups.ts). Named for the status the
 * task reached; reaching done is told apart by how: its run finished, its PR was seen merged, or a person marked it done.
 * A closed PR changes no status, but has its own event: it may strand the tasks that build on it.
 */
export type DomainEventType =
  | 'TaskStarted'
  | 'TaskQueued'
  | 'TaskFinished'
  | 'TaskPrMerged'
  | 'TaskPrClosed'
  | 'TaskMarkedDone'
  | 'TaskBlocked'
  | 'TaskFailed'
  | 'TaskCancelRequested'
  | 'TaskCancelled';

export const DOMAIN_EVENT_TYPES: DomainEventType[] = [
  'TaskStarted',
  'TaskQueued',
  'TaskFinished',
  'TaskPrMerged',
  'TaskPrClosed',
  'TaskMarkedDone',
  'TaskBlocked',
  'TaskFailed',
  'TaskCancelRequested',
  'TaskCancelled',
];

/** The status change of one task. `applyEvent` (db/work/tasks-status.ts) records it as a task_events row and returns it. */
export interface DomainEvent {
  /** What happened, named for the status the task reached. */
  type: DomainEventType;
  task_id: TaskId;
  from: TaskStatus;
  to: TaskStatus;
  /** The type of its timeline row: the event's, or `environment_block` for a block the environment caused. */
  history: TaskEventType;
  /** Why, as the timeline row records it: the stop reason, or a person's note. */
  reason: string | null;
}

/** The domain event a rule's move to `to` is. */
export function domainEventType(cause: RuleKey, to: TaskStatus): DomainEventType {
  return eventTypeOf(to, cause === 'pr_merged' || cause === 'mark_done' ? cause : 'finished');
}

/**
 * The domain event a timeline row records, read back from the row: a `pr_closed` row is a closed PR, whatever the task's
 * status; any other is the status it reached, and for done, how (a `pr_merged` or `mark_done` row; any other is a finished
 * run). Null for a row that changed no status this way.
 */
export function domainEventOfRow(row: { type: TaskEventType; to_status: TaskStatus | null }): DomainEventType | null {
  if (row.type === 'pr_closed') return 'TaskPrClosed';
  if (!row.to_status || row.to_status === 'proposed') return null;
  return eventTypeOf(row.to_status, row.type === 'pr_merged' || row.type === 'mark_done' ? row.type : 'finished');
}

function eventTypeOf(to: TaskStatus, done: 'pr_merged' | 'mark_done' | 'finished'): DomainEventType {
  switch (to) {
    case 'running':
      return 'TaskStarted';
    case 'queued':
      return 'TaskQueued';
    case 'done':
      return done === 'pr_merged' ? 'TaskPrMerged' : done === 'mark_done' ? 'TaskMarkedDone' : 'TaskFinished';
    case 'blocked':
      return 'TaskBlocked';
    case 'failed':
      return 'TaskFailed';
    case 'cancel_requested':
      return 'TaskCancelRequested';
    case 'cancelled':
      return 'TaskCancelled';
    case 'proposed':
      throw new Error('no rule moves a task to proposed');
  }
}

/** What `transition` reads of a task. */
export type TransitionTask = TaskState &
  Pick<TaskCore, 'id' | 'attempts' | 'max_attempts' | 'restarts'> & { pr: Pick<PullRequest, 'state'> | null };

/** The counters an event sets, with their new values. A counter not listed is left as it is. */
export interface TaskCounters {
  attempts?: number;
  max_attempts?: number;
  restarts?: number;
}

export interface Transition {
  /** The status the event leads to, and all the task carries in it. */
  state: TaskState;
  counters: TaskCounters;
  /** What the change does to the task's PR, written with it (`statusChangePrChanges` in task-writes.ts). */
  changes: TaskChanges;
  /** What happened, for the timeline and the follow-ups: the status change. */
  event: DomainEvent;
}

/**
 * The state a task moves to. A retry, a landing or a new block leaves nothing behind (the timeline keeps the history): an unblock
 * run's question answers one block, and a stop reason one stop. A cancel keeps the stop reason of the block or failure it ended.
 */
function nextState(from: TaskState, to: TaskStatus, event: TaskEvent, opts: TransitionOptions): TaskState {
  const reason = opts.reason ?? null;
  switch (to) {
    case 'done':
      return { status: to, done_by: event.type === 'mark_done' ? 'person' : null };
    case 'blocked':
      return { status: to, stop_reason: reason, needs: event.type === 'finish' ? (opts.needs ?? null) : null, question: null };
    case 'failed':
      return { status: to, stop_reason: reason };
    case 'cancelled':
      return { status: to, stop_reason: stopReasonOf(from) };
    default:
      return { status: to };
  }
}

/** What a run or a person says about an event: why the task stopped, and what its worker needs. */
export interface TransitionOptions {
  reason?: string | null;
  needs?: Needs | null;
}

/**
 * What `event` does to `task`: the state it leads to, the new value of every counter it sets, what it does to the PR and the
 * domain events it makes; null if the event isn't allowed from the task's status. A failed run is requeued while the task has
 * attempts left, unless the event forbids it (the worker crashed). A cancelled outcome (the cancel
 * wins from `cancel_requested`) changes no counter. A retry starts the task's restarts afresh, as it does its attempts: a
 * task once failed for restarts gets MAX_RESTARTS of them again.
 */
export function transition(task: TransitionTask, event: TaskEvent, opts: TransitionOptions = {}): Transition | null {
  const cause = ruleKey(event, task);
  const to = RULES[cause][task.status];
  if (!to) return null;
  const environment = event.type === 'finish' && event.outcome === 'blocked' && event.environment === true;
  const domainEvent: DomainEvent = {
    type: domainEventType(cause, to),
    task_id: task.id,
    from: task.status,
    to,
    history: environment ? 'environment_block' : event.type,
    reason: opts.reason ?? null,
  };
  const state = nextState(task, to, event, opts);
  const retried = event.type === 'retry' || event.type === 'unblock_retry' || event.type === 'review_retry';
  const changes = statusChangePrChanges(task.status, to, retried, task.pr);
  const counters: TaskCounters = {};
  if (to === 'cancelled') return { state, counters, changes, event: domainEvent };

  const given = Math.max(task.attempts - 1, 0); // the attempt given back
  if (event.type === 'claim') counters.attempts = task.attempts + 1;
  else if (event.type === 'retry' || event.type === 'review_retry') {
    counters.max_attempts = task.attempts + 1; // one more attempt on top of those used
    counters.restarts = 0;
  } else if (event.type === 'unblock_retry') counters.restarts = 0;
  else if (event.type === 'rate_limited' || environment) counters.attempts = given;
  else if (event.type === 'recover') {
    counters.restarts = task.restarts + 1;
    if (to === 'queued') counters.attempts = given;
  }
  return { state, counters, changes, event: domainEvent };
}

/** A task requeued by this many daemon restarts is failed instead, in case the task itself kills the daemon. */
export const MAX_RESTARTS = 3;

/** Whether one more daemon restart, after `restarts` of them, is too many: the recover fails the task instead of requeuing it. */
export const restartsExhausted = (restarts: number): boolean => restarts + 1 >= MAX_RESTARTS;
