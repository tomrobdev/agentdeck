import type { TaskSummary } from '../../../../../daemon/src/api/contract/work.ts';
import { personEvents } from '../../../../../daemon/src/domain/work/index.ts';
import { EDITABLE_STATUSES, buildsOnError, canStartMerge } from '../../../../../daemon/src/domain/work/index.ts';
import { asTaskId } from '../../../../../daemon/src/domain/shared/index.ts';

export type BulkAction = 'approve' | 'reject' | 'retry' | 'merge' | 'cancel';
export const BULK_ACTIONS: BulkAction[] = ['approve', 'reject', 'retry', 'merge', 'cancel'];

const allows = (t: TaskSummary, a: BulkAction) => (a === 'merge' ? canStartMerge(t) : personEvents(t).includes(a));

export function bulkActions(tasks: TaskSummary[]): BulkAction[] {
  if (!tasks.length) return [];
  return BULK_ACTIONS.filter((a) => tasks.every((t) => allows(t, a)));
}

export const mergeAllIds = (group: { key: string; tasks: readonly TaskSummary[] }): number[] =>
  group.key === 'review' ? group.tasks.filter(canStartMerge).map((t) => t.id) : [];

export function idRange(order: number[], from: number | null, to: number): number[] {
  const a = from === null ? -1 : order.indexOf(from);
  const b = order.indexOf(to);
  if (a === -1 || b === -1) return [to];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

const DONE_WORD: Record<BulkAction, string> = {
  approve: 'approved',
  reject: 'rejected',
  retry: 'retried',
  merge: 'merged',
  cancel: 'cancelled',
};

export interface BulkResult {
  id: number;
  error?: string;
}

export function summarizeBulk(action: BulkAction, results: BulkResult[]): string {
  const failed = results.filter((r) => r.error !== undefined).length;
  const ok = results.length - failed;
  return [ok ? `${ok} ${DONE_WORD[action]}` : '', failed ? `${failed} failed` : ''].filter(Boolean).join(' · ') || `0 ${DONE_WORD[action]}`;
}

export function bulkMessage(action: BulkAction, results: BulkResult[]): string {
  const ok = results.filter((r) => r.error === undefined).length;
  const failures = results.filter((r) => r.error !== undefined).map((r) => `#${r.id} failed: ${r.error}`);
  return [ok ? `${ok} ${DONE_WORD[action]}` : '', ...failures].filter(Boolean).join(' · ') || summarizeBulk(action, results);
}

export function buildsOnChain(shown: Pick<TaskSummary, 'id' | 'status' | 'links'>[], id: number): number[] {
  const byId = new Map<number, Pick<TaskSummary, 'id' | 'status' | 'links'>>(shown.map((t) => [t.id, t]));
  if (!byId.has(id)) return [id];
  const seen = new Set<number>([id]);
  const stack = [id];
  while (stack.length) {
    const t = byId.get(stack.pop()!);
    for (const l of t?.links ?? []) {
      const dep = byId.get(l.on);
      if (l.kind !== 'builds_on' || !dep || dep.status === 'done' || seen.has(dep.id)) continue;
      seen.add(dep.id);
      stack.push(dep.id);
    }
  }
  return shown.filter((t) => seen.has(t.id)).map((t) => t.id);
}

export const pickAll = (picked: number[], order: number[]): number[] => [...new Set([...picked, ...order])];

export function keepPicked(picked: number[], shown: number[]): number[] {
  const ids = new Set(shown);
  return picked.filter((id) => ids.has(id));
}

export function toggleGroupPicks(picked: number[], group: number[]): number[] {
  return group.every((id) => picked.includes(id)) ? picked.filter((id) => !group.includes(id)) : pickAll(picked, group);
}

export type BulkEdit = 'priority' | 'model' | 'auto_merge' | 'builds_on' | 'after';

const EDIT_WORD: Record<BulkEdit, string> = {
  priority: 'priority set',
  model: 'model set',
  auto_merge: 'auto-merge set',
  builds_on: 'now build on',
  after: 'now after',
};

export interface BulkLeftOut {
  id: number;
  reason: string;
}

type Editable = Pick<TaskSummary, 'id' | 'status' | 'pr_state'>;

export function editRefusal(task: Editable, edit: BulkEdit, on?: number): string | null {
  switch (edit) {
    case 'priority':
    case 'model':
      return EDITABLE_STATUSES.includes(task.status) ? null : `is ${task.status}; only ${EDITABLE_STATUSES.join(', ')} tasks can be edited`;
    case 'auto_merge':
      if (task.status === 'cancelled') return 'is cancelled';
      return task.pr_state === 'merged' || task.pr_state === 'closed' ? `has its PR ${task.pr_state}` : null;
    case 'builds_on':
      if (on === task.id) return "can't build on itself";
      return (
        buildsOnError(asTaskId(task.id), task.status, asTaskId(on ?? 0)) && 'has started already, so it can only go after another task'
      );
    case 'after':
      return on === task.id ? "can't go after itself" : null;
  }
}

export function planBulkEdit(tasks: Editable[], edit: BulkEdit, on?: number): { allowed: number[]; left: BulkLeftOut[] } {
  const allowed: number[] = [];
  const left: BulkLeftOut[] = [];
  for (const t of tasks) {
    const reason = editRefusal(t, edit, on);
    if (reason === null) allowed.push(t.id);
    else left.push({ id: t.id, reason });
  }
  return { allowed, left };
}

export function bulkEditMessage(edit: BulkEdit, results: BulkResult[], left: BulkLeftOut[], detail = ''): string {
  const ok = results.filter((r) => r.error === undefined).length;
  const failures = results.filter((r) => r.error !== undefined).map((r) => `#${r.id} failed: ${r.error}`);
  const word = `${EDIT_WORD[edit]}${detail ? ` ${detail}` : ''}`;
  const skipped = left.map((l) => `#${l.id} left out: ${l.reason}`);
  return [ok ? `${ok} ${word}` : '', ...failures, ...skipped].filter(Boolean).join(' · ') || `0 ${word}`;
}
