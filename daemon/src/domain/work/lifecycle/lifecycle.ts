// The task state machine, as data.
import type { TaskId } from '#domain/shared/index.ts';
import type { PullRequest } from '#domain/landing/index.ts';
import type { TaskEventType } from '#domain/work/lifecycle/history.ts';
import type { Needs } from '#domain/work/task/needs.ts';
import { type TaskCore, type TaskState, attemptsLeft, stopReasonOf } from '#domain/work/task/task.ts';
import { type TaskChanges, statusChangePrChanges } from '#domain/work/lifecycle/task-writes.ts';

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

export function ruleKey(e: TaskEvent, counters: RuleCounters = {}): RuleKey {
  if (e.type === 'finish') {
    if (e.outcome !== 'failed') return `finish:${e.outcome}`;
    return e.retry !== false && attemptsLeft({ attempts: counters.attempts ?? 0, max_attempts: counters.max_attempts ?? 0 })
      ? 'finish:failed:retry'
      : 'finish:failed';
  }
  if (e.type === 'recover') return restartsExhausted(counters.restarts ?? 0) ? 'recover:exhausted' : 'recover';
  return e.type;
}

export function nextStatus(from: TaskStatus, event: TaskEvent, counters: RuleCounters = {}): TaskStatus | undefined {
  return RULES[ruleKey(event, counters)][from];
}

export function canApply(from: TaskStatus, event: TaskEvent): boolean {
  return nextStatus(from, event) !== undefined;
}

/** The events a person can ask for. */
export type PersonEvent = 'approve' | 'reject' | 'retry' | 'cancel' | 'mark_done';
const PERSON_EVENTS: PersonEvent[] = ['approve', 'reject', 'retry', 'cancel', 'mark_done'];

export function personEvents(t: { status: TaskStatus }): PersonEvent[] {
  return PERSON_EVENTS.filter((type) => canApply(t.status, { type }) && !(type === 'cancel' && t.status === 'proposed'));
}

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

export function domainEventType(cause: RuleKey, to: TaskStatus): DomainEventType {
  return eventTypeOf(to, cause === 'pr_merged' || cause === 'mark_done' ? cause : 'finished');
}

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
    case 'proposed':
    case 'queued':
    case 'running':
    case 'cancel_requested':
      return { status: to };
  }
}

/** What a run or a person says about an event: why the task stopped, and what its worker needs. */
export interface TransitionOptions {
  reason?: string | null;
  needs?: Needs | null;
}

export function transition(task: TransitionTask, event: TaskEvent, opts: TransitionOptions = {}): Transition | null {
  const cause = ruleKey(event, task);
  const to = RULES[cause][task.status];
  if (!to) return null;
  if (event.type === 'review_retry' && task.pr?.state === 'merged') return null;
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

  const given = Math.max(task.attempts - 1, 0);
  if (event.type === 'claim') counters.attempts = task.attempts + 1;
  else if (event.type === 'retry' || event.type === 'review_retry') {
    counters.max_attempts = Math.max(task.max_attempts, task.attempts + 1);
    counters.restarts = 0;
  } else if (event.type === 'unblock_retry') counters.restarts = 0;
  else if (event.type === 'rate_limited' || environment) counters.attempts = given;
  else if (event.type === 'recover') {
    counters.restarts = task.restarts + 1;
    if (to === 'queued') counters.attempts = given;
  }
  return { state, counters, changes, event: domainEvent };
}

export const MAX_RESTARTS = 3;

export const restartsExhausted = (restarts: number): boolean => restarts + 1 >= MAX_RESTARTS;
