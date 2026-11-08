// What a bar over several selected tasks may offer: the actions every one of them allows. What a person may do
// with one task is the daemon's (personEvents, canStartMerge); this only intersects.
// Free of the dashboard's other modules so the daemon's tests can import it (daemon/test/bulk-actions.test.ts).
import type { TaskSummary } from '../../../daemon/src/api/contract.ts';
import { personEvents } from '../../../daemon/src/domain/work/index.ts';
import { canStartMerge } from '../../../daemon/src/domain/work/index.ts';

export type BulkAction = 'approve' | 'reject' | 'retry' | 'merge' | 'cancel';
export const BULK_ACTIONS: BulkAction[] = ['approve', 'reject', 'retry', 'merge', 'cancel'];

const allows = (t: TaskSummary, a: BulkAction) => (a === 'merge' ? canStartMerge(t) : personEvents(t).includes(a));

/** The actions every task allows, in the bar's order; none for an empty selection. */
export function bulkActions(tasks: TaskSummary[]): BulkAction[] {
  if (!tasks.length) return [];
  return BULK_ACTIONS.filter((a) => tasks.every((t) => allows(t, a)));
}

/** The PRs a group's "Merge all" would merge: only Review has any, less the ones syncing or already asked to merge. */
export const mergeAllIds = (group: { key: string; tasks: readonly TaskSummary[] }): number[] =>
  group.key === 'review' ? group.tasks.filter(canStartMerge).map((t) => t.id) : [];

/** The ids from `from` to `to` inclusive in `order`, whichever comes first; just `to` when `from` isn't in it. */
export function idRange(order: number[], from: number | null, to: number): number[] {
  const a = from === null ? -1 : order.indexOf(from);
  const b = order.indexOf(to);
  if (a === -1 || b === -1) return [to];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}
