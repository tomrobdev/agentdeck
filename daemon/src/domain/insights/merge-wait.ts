// The time from a task's first done to its merge, split by what it waited on, and the slowest tasks.
import { isAutoMergeReason } from '#domain/work/index.ts';
import { median, minutesBetween } from '#domain/shared/index.ts';
import type { TaskId } from '#domain/shared/index.ts';
import type { ScorecardEvent } from '#domain/insights/scorecard.ts';
import { num, table } from '#domain/insights/report-text.ts';

export const WAIT_KINDS = ['person', 'checks', 'conflict', 'sync', 'other'] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];

export interface MergeWait {
  /** Minutes from the first done to the merge. */
  minutes: number;
  /** Minutes by what the task waited on; the kinds add up to `minutes`. */
  waits: Record<WaitKind, number>;
}

export interface SlowTask {
  task_id: TaskId;
  minutes: number;
  waits: Record<WaitKind, number>;
}

export interface MergeWaitMeasures {
  tasks: number;
  median_minutes: number | null;
  slowest: SlowTask[];
}

export const SLOWEST_TASKS = 5;

const isMerge = (e: ScorecardEvent) => e.type === 'merge' || e.type === 'pr_merged' || (e.type === 'pr' && e.reason === 'PR is merged');

function waitEndedBy(e: ScorecardEvent): WaitKind {
  if (e.type === 'sync') return (e.reason ?? '').startsWith('Resolved conflicts') ? 'conflict' : 'sync';
  if (isMerge(e)) return e.type === 'merge' && isAutoMergeReason(e.reason) ? 'checks' : 'person';
  return 'other';
}

export function mergeWaitOf(events: ScorecardEvent[]): MergeWait | null {
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const finished = sorted.find((e) => e.type === 'finish' && e.to_status === 'done');
  if (!finished) return null;
  const after = sorted.filter((e) => e.at >= finished.at && e !== finished);
  const end = after.findIndex(isMerge);
  if (end < 0) return null;
  const waits = Object.fromEntries(WAIT_KINDS.map((k) => [k, 0])) as Record<WaitKind, number>;
  let from = finished.at;
  for (const e of after.slice(0, end + 1)) {
    waits[waitEndedBy(e)] += minutesBetween(from, e.at);
    from = e.at;
  }
  return { minutes: minutesBetween(finished.at, after[end].at), waits };
}

export function measureMergeWait(eventsByTask: Map<TaskId, ScorecardEvent[]>, tasks: TaskId[]): MergeWaitMeasures {
  const waited = tasks.flatMap((id) => {
    const w = mergeWaitOf(eventsByTask.get(id) ?? []);
    return w ? [{ task_id: id, ...w }] : [];
  });
  return {
    tasks: waited.length,
    median_minutes: median(waited.map((w) => w.minutes)),
    slowest: [...waited].sort((a, b) => b.minutes - a.minutes).slice(0, SLOWEST_TASKS),
  };
}

export function mergeWaitText(m: MergeWaitMeasures): string {
  const head = `done to merged: median ${num(m.median_minutes)} min over ${m.tasks} task${m.tasks === 1 ? '' : 's'}`;
  if (!m.slowest.length) return head;
  const rows = m.slowest.map((s) => [`#${s.task_id}`, num(s.minutes), ...WAIT_KINDS.map((k) => num(s.waits[k]))]);
  return `${head}\n\n${table(['slowest', 'min', ...WAIT_KINDS], rows)}`;
}
