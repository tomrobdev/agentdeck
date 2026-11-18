// What counts as an intervention in the pilot scorecard.
import { isAutoMergeReason } from '#domain/work/index.ts';
import { INSTALL_NOTE } from '#domain/work/index.ts';
import type { ScorecardEvent, ScorecardTask } from '#domain/insights/scorecard.ts';

/**
 * An intervention is something a person did that changed how a task turned out, which the pilot wants to bring to
 * zero. Each kind says why it counts. Approving or rejecting a proposal is how the planner is meant to be used, and
 * a plain retry (no note) only asks again, so neither is here.
 */
export interface Intervention {
  kind: string;
  why: string;
  is(e: ScorecardEvent, task: ScorecardTask): boolean;
}

const retried = (e: ScorecardEvent) => e.type === 'retry';
const noted = (e: ScorecardEvent) => (e.reason?.trim() ?? '') !== '';
const installed = (e: ScorecardEvent) => retried(e) && (e.reason ?? '').startsWith(INSTALL_NOTE);

export const INTERVENTIONS: Intervention[] = [
  {
    kind: 'retry_with_note',
    why: 'the person told the worker what to do differently, so the first attempt was not enough',
    is: (e) => retried(e) && noted(e) && !installed(e),
  },
  {
    kind: 'mark_done',
    why: 'the person finished or landed the work themselves',
    is: (e) => e.type === 'mark_done',
  },
  {
    kind: 'install_needs',
    why: 'the worker could not install packages itself and a person did it for it (recorded as a retry with that note)',
    is: installed,
  },
  {
    kind: 'cancel',
    why: 'the person stopped work that was going wrong or no longer wanted',
    is: (e) => e.type === 'cancel',
  },
  {
    kind: 'edit',
    why: 'the person rewrote a task that was waiting or stuck to get a different outcome (edits to a proposal or a failed task are left out)',
    is: (e) => e.type === 'edit' && (e.from_status === 'queued' || e.from_status === 'blocked'),
  },
  {
    kind: 'manual_merge',
    why: 'auto-merge was on, yet the person merged the PR by hand',
    is: (e, task) => e.type === 'merge' && task.auto_merge_from !== null && e.at >= task.auto_merge_from && !isAutoMergeReason(e.reason),
  },
];

export const INTERVENTION_KINDS = INTERVENTIONS.map((i) => i.kind);

export function interventionKind(e: ScorecardEvent, task: ScorecardTask): string | null {
  return INTERVENTIONS.find((i) => i.is(e, task))?.kind ?? null;
}

export interface InterventionCount {
  total: number;
  /** Distinct tasks that had at least one. */
  tasks: number;
  by_kind: Record<string, number>;
}

export function countInterventions(events: ScorecardEvent[], tasks: Map<number, ScorecardTask>): InterventionCount {
  const by_kind = Object.fromEntries(INTERVENTION_KINDS.map((k) => [k, 0]));
  const hit = new Set<number>();
  let total = 0;
  for (const e of events) {
    const task = tasks.get(e.task_id);
    const kind = task ? interventionKind(e, task) : null;
    if (!kind) continue;
    by_kind[kind]++;
    total++;
    hit.add(e.task_id);
  }
  return { total, tasks: hit.size, by_kind };
}
