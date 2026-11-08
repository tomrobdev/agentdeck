// The task state machine, as data. Pure: no I/O, so it can be tested exhaustively.
// applyEvent and claimNextTask (db/tasks.ts) are the only things that write a status, and each asks this module first.
import type { TaskId } from '../shared/index.ts';
import type { TaskEventType } from './history.ts';
import type { Needs } from './needs.ts';
import { type TaskCore, type TaskState, stopReasonOf } from './task.ts';

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
  | { type: 'unblock_retry' } // an unblock run sent a blocked task back with a note; its attempts stay as they are
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
  | 'unblock_retry'
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
export function personEvents(t: { status: TaskStatus }): PersonEvent[] {
  return PERSON_EVENTS.filter((type) => canApply(t.status, { type }) && !(type === 'cancel' && t.status === 'proposed'));
}

/** Every status `event` is allowed from (for guards like `WHERE status IN (...)`). */
export function fromStatuses(event: TaskEvent): TaskStatus[] {
  return Object.keys(RULES[ruleKey(event)]) as TaskStatus[];
}

/** Who asked for an event: a person (the person events above), or the daemon on its own (every other event). */
export type Actor = 'daemon' | 'person';

export const actorOf = (cause: RuleKey): Actor => ((PERSON_EVENTS as string[]).includes(cause) ? 'person' : 'daemon');

/**
 * What a status change says happened, read by its follow-ups (`FOLLOW_UPS` in follow-ups.ts). Named for the status the
 * task reached; reaching done is told apart by how: its run finished, its PR was seen merged, or a person marked it done.
 */
export type DomainEventType =
  | 'TaskStarted'
  | 'TaskQueued'
  | 'TaskFinished'
  | 'TaskPrMerged'
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
  'TaskMarkedDone',
  'TaskBlocked',
  'TaskFailed',
  'TaskCancelRequested',
  'TaskCancelled',
];

/** One status change of one task. `applyEvent` (db/tasks.ts) records each as a task_events row and returns them. */
export interface DomainEvent {
  /** What happened, named for the status the task reached. */
  type: DomainEventType;
  task_id: TaskId;
  /** The lifecycle event that caused it, by its rule key. */
  cause: RuleKey;
  /** Who asked for that event. */
  by: Actor;
  from: TaskStatus;
  to: TaskStatus;
  /** The type of its timeline row: the event's, or `environment_block` for a block the environment caused. */
  history: TaskEventType;
  /** Why, as the timeline row records it: the stop reason, or a person's note. */
  reason: string | null;
}

/** The domain event a rule's move to `to` is. */
export function domainEventType(cause: RuleKey, to: TaskStatus): DomainEventType {
  switch (to) {
    case 'running':
      return 'TaskStarted';
    case 'queued':
      return 'TaskQueued';
    case 'done':
      return cause === 'pr_merged' ? 'TaskPrMerged' : cause === 'mark_done' ? 'TaskMarkedDone' : 'TaskFinished';
    case 'blocked':
      return 'TaskBlocked';
    case 'failed':
      return 'TaskFailed';
    case 'cancel_requested':
      return 'TaskCancelRequested';
    case 'cancelled':
      return 'TaskCancelled';
    case 'proposed':
      throw new Error(`no rule moves a task to proposed (${cause})`);
  }
}

/** What `transition` reads of a task. */
export type TransitionTask = TaskState & Pick<TaskCore, 'id' | 'attempts' | 'restarts'>;

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
  /** What happened, for the timeline and the follow-ups: one event, the status change. */
  events: DomainEvent[];
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
 * What `event` does to `task`: the state it leads to, the new value of every counter it sets and the
 * domain events it makes; null if the event isn't allowed from the task's status. A cancelled outcome (the cancel
 * wins from `cancel_requested`) changes no counter.
 */
export function transition(task: TransitionTask, event: TaskEvent, opts: TransitionOptions = {}): Transition | null {
  const to = nextStatus(task.status, event);
  if (!to) return null;
  const environment = event.type === 'finish' && event.outcome === 'blocked' && event.environment === true;
  const cause = ruleKey(event);
  const events: DomainEvent[] = [
    {
      type: domainEventType(cause, to),
      task_id: task.id,
      cause,
      by: actorOf(cause),
      from: task.status,
      to,
      history: environment ? 'environment_block' : event.type,
      reason: opts.reason ?? null,
    },
  ];
  const state = nextState(task, to, event, opts);
  const counters: TaskCounters = {};
  if (to === 'cancelled') return { state, counters, events };

  const given = Math.max(task.attempts - 1, 0); // the attempt given back
  if (event.type === 'claim') counters.attempts = task.attempts + 1;
  else if (event.type === 'retry')
    counters.max_attempts = task.attempts + 1; // one more attempt on top of those used
  else if (event.type === 'rate_limited' || environment) counters.attempts = given;
  else if (event.type === 'recover') {
    counters.restarts = task.restarts + 1;
    if (to === 'queued') counters.attempts = given;
  }
  return { state, counters, events };
}

/** A task requeued by this many daemon restarts is failed instead, in case the task itself kills the daemon. */
export const MAX_RESTARTS = 3;
