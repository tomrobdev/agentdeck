import type { TaskSummary } from '#daemon/api/contract/work.ts';
import { type PersonEvent, personEvents } from '#daemon/domain/work/index.ts';
import { type StatusGroup, statusGroup } from '#daemon/domain/work/index.ts';

export type BoardMove = PersonEvent | 'merge';
export function boardMove(t: Pick<TaskSummary, 'status' | 'waiting' | 'pr_state'>, to: StatusGroup): BoardMove | null {
  const from = statusGroup(t);
  if (from === to) return null;
  if (from === 'proposed') return to === 'queued' ? 'approve' : to === 'cancelled' ? 'reject' : to === 'parked' ? 'park' : null;
  if (from === 'parked') return to === 'proposed' ? 'lift' : to === 'cancelled' ? 'reject' : null;
  if (from === 'review' && to === 'done') return 'merge';
  const events = personEvents(t);
  if (to === 'queued' && events.includes('retry')) return 'retry';
  if (to === 'done' && events.includes('mark_done')) return 'mark_done';
  if (to === 'cancelled' && events.includes('cancel') && t.status !== 'running') return 'cancel';
  return null;
}
