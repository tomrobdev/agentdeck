// Which lifecycle event a drop on the board means. Free of the dashboard's other modules so the daemon's tests can import it
// (daemon/test/board-move.test.ts); taskView.ts re-exports it. What a person may do in a status is the daemon's personEvents
// (domain/work/lifecycle.ts); the status groups it moves between are in the daemon's stage.ts.
import type { TaskSummary } from '../../../daemon/src/api/contract.ts';
import { type PersonEvent, personEvents } from '../../../daemon/src/domain/work/index.ts';
import { type StatusGroup, statusGroup } from '../../../daemon/src/domain/work/index.ts';

/** Board moves: which lifecycle event a drop from one status group to another means, if any. `merge` merges a PR in review. */
export type BoardMove = PersonEvent | 'merge';
export function boardMove(t: Pick<TaskSummary, 'status' | 'waiting' | 'pr_state'>, to: StatusGroup): BoardMove | null {
  const from = statusGroup(t);
  if (from === to) return null;
  if (from === 'proposed') return to === 'queued' ? 'approve' : to === 'cancelled' ? 'reject' : null;
  // Review to Done is the merge itself: the daemon refuses one that can't merge.
  if (from === 'review' && to === 'done') return 'merge';
  const events = personEvents(t);
  if (to === 'queued' && events.includes('retry')) return 'retry';
  if (to === 'done' && events.includes('mark_done')) return 'mark_done';
  // A running task is stopped from its page, never by a drop.
  if (to === 'cancelled' && events.includes('cancel') && t.status !== 'running') return 'cancel';
  return null;
}
