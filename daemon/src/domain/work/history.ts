// A task's history: one row per status change. Pure: no I/O.
import type { TaskId } from '../shared/index.ts';
import type { MergeMethod } from '../repos/index.ts';
import type { PrState } from '../landing/index.ts';
import type { TaskEvent, TaskStatus } from './lifecycle.ts';

/**
 * `created` when the task was added, `edit` when a person changed its fields (the status stays as it was), `merge` when its PR was merged from the app and `sync` when a sync
 * changed the task's branch (the status stays as it was), `pr` when its pull request was opened, failed to open, was closed
 * or was seen merged or closed on GitHub (likewise), `plan_unfinished` when a done run left linked plan steps
 * unfinished (a warning, the status stays as it was), `environment_block` when a run blocked because of the environment and
 * its attempt was given back, `unblock_ask` when an unblock run left a blocked task blocked with a question (the status
 * stays as it was; the reason is the question), otherwise the lifecycle event that changed its status.
 */
export type TaskEventType =
  'created' | 'edit' | 'merge' | 'pr' | 'sync' | 'plan_unfinished' | 'environment_block' | 'unblock_ask' | TaskEvent['type'];

/** What happened to a task's pull request. `seen` is what GitHub says about an open one. */
export type PrEvent =
  { type: 'opened'; url: string } | { type: 'failed'; error: string } | { type: 'closed' } | { type: 'seen'; state: PrState };

/** The reason a `pr` history row records for a PR event. Readers: `isPrOpenedReason`, `prSeenState`. */
export function prEventReason(e: PrEvent): string {
  switch (e.type) {
    case 'opened':
      return `opened ${e.url}`;
    case 'failed':
      return `could not open the PR: ${e.error}`;
    case 'closed':
      return 'closed without merging';
    case 'seen':
      return `PR is ${e.state}`;
  }
}

/** Whether a `pr` row's reason is that of an opened PR. */
export const isPrOpenedReason = (reason: string | null): boolean => !!reason?.startsWith('opened ');

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

/**
 * The note on the task's latest retry ("changes requested in review"), or null if that retry had none. A retry by an
 * unblock run counts: its note starts with UNBLOCK_NOTE (domain/runs/unblock.ts).
 */
export function latestReviewNote(events: Pick<TaskEventRow, 'type' | 'reason'>[]): string | null {
  return events.findLast((e) => e.type === 'retry' || e.type === 'unblock_retry')?.reason ?? null;
}
