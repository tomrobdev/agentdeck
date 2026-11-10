// What the peek pane and the queue's rows say of a task's model, properties and links, as plain values.
import type { PlanStep, TaskLink, TaskSummary } from '../../../../../daemon/src/api/contract/work.ts';
import { canStartMerge, personEvents, statusGroup } from '../../../../../daemon/src/domain/work/index.ts';

type Modeled = Pick<TaskSummary, 'model' | 'run_model'>;

export function modelChip(t: Modeled): { text: string; title: string } {
  const run = t.run_model;
  if (run && run !== t.model) return { text: run, title: `Latest run on ${run}; task: ${t.model}` };
  return { text: t.model, title: `Model: ${t.model}` };
}

export function modelLine(t: Modeled, runModelId: string | null): { text: string; title: string } {
  const run = t.run_model;
  if (run && run !== t.model) return { text: `${run} · task: ${t.model}`, title: runModelId ?? run };
  return { text: t.model, title: runModelId ?? t.model };
}

type Propped = Modeled & Pick<TaskSummary, 'priority' | 'attempts' | 'max_attempts' | 'max_turns' | 'auto_merge'>;

export function peekProps(t: Propped): { label: string; text: string }[] {
  return [
    { label: 'Priority', text: String(t.priority) },
    { label: 'Attempt', text: `${t.attempts} / ${t.max_attempts}` },
    { label: 'Max turns', text: String(t.max_turns) },
    { label: 'Auto-merge', text: t.auto_merge === null ? "the repo's" : t.auto_merge ? 'on' : 'off' },
  ];
}

const LINK_KIND = { builds_on: 'builds on', after: 'after' } as const;
const LINK_STATE = { met: '✓ merged', waiting: 'waiting', stuck: 'stuck', unlanded: 'not landed yet' } as const;

export function linkParts(links: TaskLink[]): { id: number; text: string; state: TaskLink['state'] }[] {
  return links.map((l) => ({ id: l.on, text: `${LINK_KIND[l.kind]} #${l.on} ${LINK_STATE[l.state]}`, state: l.state }));
}

export const neededBy = (dependents: { id: number }[]): number[] => dependents.map((d) => d.id);

export function ownSteps(steps: PlanStep[], planSteps: string | null): PlanStep[] {
  if (planSteps === null) return steps.filter((s) => s.status !== 'done' && s.status !== 'skipped');
  let ids: unknown;
  try {
    ids = JSON.parse(planSteps);
  } catch {
    ids = null;
  }
  if (!Array.isArray(ids)) return steps.filter((s) => s.status !== 'done' && s.status !== 'skipped');
  return steps.filter((s) => s.id !== null && ids.includes(s.id));
}

export type PeekAction = 'approve' | 'reject' | 'retry' | 'merge' | 'cancel';

export function peekActions(
  t: Pick<TaskSummary, 'status' | 'waiting' | 'pr_state'> & { sync?: unknown; merge_request?: unknown },
): PeekAction[] {
  const events = personEvents(t);
  const out: PeekAction[] = [];
  if (events.includes('approve')) out.push('reject', 'approve');
  if (events.includes('retry') && statusGroup(t) === 'needs-you') out.push('retry');
  if (canStartMerge(t)) out.push('merge');
  if (t.status === 'running' && events.includes('cancel')) out.push('cancel');
  return out;
}
