// A task's history: one row per status change. Pure: no I/O.
import type { TaskId } from '../shared/index.ts';
import type { MergeMethod } from '../repos/index.ts';
import { type BranchPr, type PrOpenFailures, type PrRetry, type PrState, prRetry } from '../landing/index.ts';
import type { TaskEvent, TaskStatus } from './lifecycle.ts';

/**
 * `created` when the task was added, `edit` when a person changed its fields (the status stays as it was), `merge` when its PR was merged from the app and `sync` when a sync
 * changed the task's branch (the status stays as it was), `pr` when its pull request was opened, failed to open or was seen merged on GitHub (likewise), `pr_closed` when its pull
 * request was closed or seen closed (likewise; its follow-up warns the tasks that now cannot start), `plan_unfinished` when a done run left linked plan steps
 * unfinished (a warning, the status stays as it was), `environment_block` when a run blocked because of the environment and
 * its attempt was given back, `unblock_ask` when an unblock run left a blocked task blocked with a question (the status
 * stays as it was; the reason is the question), `escalate` when a failure moved the task's model one up for its next attempt
 * (the status stays as it was; the reason says why, domain/runs/escalate.ts), otherwise the lifecycle event that changed its status.
 */
export type TaskEventType =
  | 'created'
  | 'edit'
  | 'merge'
  | 'pr'
  | 'pr_closed'
  | 'sync'
  | 'plan_unfinished'
  | 'environment_block'
  | 'unblock_ask'
  | 'escalate'
  | TaskEvent['type'];

/** What happened to a task's pull request. `seen` is what GitHub says about an open one. */
export type PrEvent =
  { type: 'opened'; url: string } | { type: 'failed'; error: string } | { type: 'closed' } | { type: 'seen'; state: PrState };

/**
 * The PR events that record a PR GitHub has for the task's branch: the one `gh pr create` opened, or the one it found there
 * already (`existingPr`). Opened, and then seen merged or closed when it is no longer open, so the task keeps its url either way.
 */
export const prEventsOf = (pr: BranchPr): PrEvent[] =>
  pr.state === 'open'
    ? [{ type: 'opened', url: pr.url }]
    : [
        { type: 'opened', url: pr.url },
        { type: 'seen', state: pr.state },
      ];

/** The reason a `pr` history row records for a PR event. Readers: `isPrOpenedReason`, `prSeenState`. */
export function prEventReason(e: PrEvent): string {
  switch (e.type) {
    case 'opened':
      return `opened ${e.url}`;
    case 'failed':
      return `${PR_FAILED}${e.error}`;
    case 'closed':
      return 'closed without merging';
    case 'seen':
      return `PR is ${e.state}`;
  }
}

/** Whether a `pr` row's reason is that of an opened PR. */
export const isPrOpenedReason = (reason: string | null): boolean => !!reason?.startsWith('opened ');

const PR_FAILED = 'could not open the PR: ';

/** The error a `pr` row's reason says the PR failed to open with, or null if it is not such a reason. */
export const prFailedError = (reason: string | null): string | null =>
  reason?.startsWith(PR_FAILED) ? reason.slice(PR_FAILED.length) : null;

/**
 * The times a task's PR failed to open since the task last finished done, from its history (oldest first): the `pr` rows
 * after its last status change, each failure counted, an opened PR starting the count again. Null when none failed.
 */
export function prOpenFailures(
  events: Pick<TaskEventRow, 'type' | 'from_status' | 'to_status' | 'reason' | 'at'>[],
): PrOpenFailures | null {
  let count = 0;
  let last: Omit<PrOpenFailures, 'count'> = { error: '', at: '' };
  for (const e of events) {
    const error = e.type === 'pr' ? prFailedError(e.reason) : null;
    if (e.from_status !== e.to_status || (e.type === 'pr' && isPrOpenedReason(e.reason))) count = 0;
    else if (error !== null) {
      count++;
      last = { error, at: e.at };
    }
  }
  return count ? { count, ...last } : null;
}

/**
 * For a done task whose PR failed to open, in a repo with a PR mode: whether the PR refresh opens it again at `now`, from the
 * failures its history (`events`) records since it finished. Null for any other task.
 */
export function prRetryFor(
  task: { status: TaskStatus; pr: { state: PrState } | null },
  repo: { pr_mode: string } | null | undefined,
  events: Parameters<typeof prOpenFailures>[0],
  now: number,
): PrRetry | null {
  if (task.status !== 'done' || task.pr?.state !== 'failed' || !repo || repo.pr_mode === 'off') return null;
  const failures = prOpenFailures(events);
  return failures ? prRetry(failures, now) : null;
}

/** The state a `pr` row's reason says GitHub showed ("PR is merged" → "merged"), or null if it is not such a reason. */
export function prSeenState(reason: string | null): string | null {
  const prefix = 'PR is ';
  return reason?.startsWith(prefix) ? reason.slice(prefix.length) : null;
}

const AUTO_MERGED = 'auto-merged';

/**
 * The reason a `merge` history row records: who merged the PR and how. The daemon on its own (`auto`), the daemon on a
 * person's merge request (`request`), or a person from the app (`person`).
 */
export function mergeReason(by: 'auto' | 'request' | 'person', method: MergeMethod): string {
  switch (by) {
    case 'auto':
      return `${AUTO_MERGED} (${method})`;
    case 'request':
      return `requested (${method})`;
    case 'person':
      return `${method} merge`;
  }
}

/** Whether a `merge` row's reason says the daemon merged the PR on its own. */
export const isAutoMergeReason = (reason: string | null): boolean => !!reason?.startsWith(AUTO_MERGED);

/** Whether a `merge` row's reason says the daemon merged the PR on a person's request. */
export const isRequestedMergeReason = (reason: string | null): boolean => !!reason?.startsWith('requested ');

export interface TaskEventRow {
  id: number;
  task_id: TaskId;
  type: TaskEventType;
  from_status: TaskStatus | null; // null for 'created'
  to_status: TaskStatus | null;
  reason: string | null;
  at: string;
}

/** A history row whose status change's follow-ups are still to run (the outbox): what the daemon's tick reads to run them. */
export type PendingFollowUp = Pick<TaskEventRow, 'id' | 'task_id' | 'type' | 'to_status'>;

/** The timeline rows of a retry: a person's, an unblock run's, or a review run's. */
const RETRY_TYPES: TaskEventType[] = ['retry', 'unblock_retry', 'review_retry'];

/** When the task was last retried, or null if it never was. Every kind of retry counts (`RETRY_TYPES`). */
export function latestRetryAt(events: Pick<TaskEventRow, 'type' | 'at'>[]): string | null {
  return events.findLast((e) => RETRY_TYPES.includes(e.type))?.at ?? null;
}

/**
 * The note on the task's latest retry ("changes requested in review"), or null if that retry had none. A retry by an
 * unblock run counts (its note starts with UNBLOCK_NOTE, domain/runs/unblock.ts), and so does a review run's.
 */
export function latestReviewNote(events: Pick<TaskEventRow, 'type' | 'reason'>[]): string | null {
  return events.findLast((e) => RETRY_TYPES.includes(e.type))?.reason ?? null;
}
