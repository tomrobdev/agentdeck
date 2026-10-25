// Which lifecycle event a drop on the board means. Free of the dashboard's other modules so the daemon's tests can import it
// (daemon/test/board-move.test.ts); taskView.ts re-exports it. The status groups it moves between are in the daemon's stage.ts.
import type { TaskSummary } from '../../daemon/src/api/contract.ts';
import { type StatusGroup, statusGroup } from '../../daemon/src/domain/task/stage.ts';

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
