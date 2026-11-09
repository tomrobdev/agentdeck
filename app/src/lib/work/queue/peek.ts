// What the peek pane and the queue's rows say of a task's model, properties and links, as plain values.
// Free of the dashboard's other modules so the daemon's tests can import it (daemon/test/peek.test.ts).
import type { PlanStep, TaskLink, TaskSummary } from '../../../../../daemon/src/api/contract/work.ts';
import { canStartMerge, personEvents, statusGroup } from '../../../../../daemon/src/domain/work/index.ts';

type Modeled = Pick<TaskSummary, 'model' | 'run_model'>;

/** The model on a row or card: the latest run's when it differs from the task's (an escalated retry), else the task's. */
export function modelChip(t: Modeled): { text: string; title: string } {
  const run = t.run_model;
  if (run && run !== t.model) return { text: run, title: `Latest run on ${run}; task: ${t.model}` };
  return { text: t.model, title: `Model: ${t.model}` };
}

/** The model in the peek: the task's, and both when the latest run used another ("opus · task: sonnet"). `hover` is the run's exact id. */
export function modelLine(t: Modeled, runModelId: string | null): { text: string; title: string } {
  const run = t.run_model;
  if (run && run !== t.model) return { text: `${run} · task: ${t.model}`, title: runModelId ?? run };
  return { text: t.model, title: runModelId ?? t.model };
}

type Propped = Modeled & Pick<TaskSummary, 'priority' | 'attempts' | 'max_attempts' | 'max_turns' | 'auto_merge'>;

/** The row under the peek's title: priority, attempt, max turns and auto-merge (on, off or the repo's). The model is shown apart. */
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

/** The task's links as one line each part: "builds on #239 ✓ merged", "after #253 waiting". */
export function linkParts(links: TaskLink[]): { id: number; text: string; state: TaskLink['state'] }[] {
  return links.map((l) => ({ id: l.on, text: `${LINK_KIND[l.kind]} #${l.on} ${LINK_STATE[l.state]}`, state: l.state }));
}

/** The tasks that depend on this one: "needed by #241". */
export const neededBy = (dependents: { id: number }[]): number[] => dependents.map((d) => d.id);

/**
 * The plan steps this task works on: the ones its `plan_steps` list names, else every step not finished. Steps with no id
 * can't be named, so they count only in the unlisted case.
 */
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

/**
 * Which actions the peek's header offers, in the order shown: the queue's own rules, so a key and a button agree. Retry is the
 * queue's quick retry (work that went wrong), Merge its `canStartMerge`.
 */
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
