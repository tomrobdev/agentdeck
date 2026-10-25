// Which lifecycle event a drop on the board means. Free of the dashboard's other modules so the daemon's tests can import it
// (daemon/test/board-move.test.ts); taskView.ts re-exports it.
import type { TaskSummary } from '../../daemon/src/api/contract.ts';

/** A done task whose pull request waits on you. */
export const isReview = (t: Pick<TaskSummary, 'status' | 'pr_state'>) => t.status === 'done' && t.pr_state === 'open';
/** A done task whose pull request is merged: finished history. */
export const isMerged = (t: Pick<TaskSummary, 'status' | 'pr_state'>) => t.status === 'done' && t.pr_state === 'merged';
export const isStuck = (t: Pick<TaskSummary, 'status' | 'waiting'>) => t.status === 'queued' && !!t.waiting?.stuck;

/** Status groups, in attention order. Every task is in exactly one; a stuck task needs you, so it isn't queued. */
export const STATUS_GROUPS = [
  { key: 'needs-you', label: 'Needs you' },
  { key: 'review', label: 'Review' },
  { key: 'proposed', label: 'Proposed' },
  { key: 'running', label: 'Running' },
  { key: 'queued', label: 'Queued' },
  { key: 'done', label: 'Done' },
  { key: 'merged', label: 'Merged' },
  { key: 'cancelled', label: 'Cancelled' },
] as const;
export type StatusGroup = (typeof STATUS_GROUPS)[number]['key'];

export function statusGroup(t: Pick<TaskSummary, 'status' | 'waiting' | 'pr_state'>): StatusGroup {
  switch (t.status) {
    case 'blocked':
    case 'failed':
      return 'needs-you';
    case 'queued':
      return isStuck(t) ? 'needs-you' : 'queued';
    case 'cancel_requested':
      return 'running';
    case 'done':
      return isReview(t) ? 'review' : isMerged(t) ? 'merged' : 'done';
    default:
      return t.status;
  }
}

type Status = Pick<TaskSummary, 'status'>;
/** What the daemon's lifecycle allows (domain/task/lifecycle.ts TRANSITIONS). */
export const canRetry = (t: Status) => ['blocked', 'failed', 'done', 'cancelled'].includes(t.status);
export const canCancel = (t: Status) => ['queued', 'running', 'blocked', 'failed'].includes(t.status);
/** A person can say a blocked or failed task is done: they finished or landed the work themselves (lifecycle mark_done). */
export const canMarkDone = (t: Status) => t.status === 'blocked' || t.status === 'failed';

/** Board moves: which lifecycle event a drop from one status group to another means, if any. */
export type BoardMove = 'approve' | 'reject' | 'retry' | 'cancel' | 'mark_done';
export function boardMove(t: Pick<TaskSummary, 'status' | 'waiting' | 'pr_state'>, to: StatusGroup): BoardMove | null {
  const from = statusGroup(t);
  if (from === to) return null;
  if (from === 'proposed') return to === 'queued' ? 'approve' : to === 'cancelled' ? 'reject' : null;
  if (to === 'queued' && canRetry(t)) return 'retry';
  if (to === 'done' && canMarkDone(t)) return 'mark_done';
  // A running task is stopped from its page, never by a drop.
  if (to === 'cancelled' && canCancel(t) && t.status !== 'running') return 'cancel';
  return null;
}
