// Landing a plan branch: when it is ready to land, its pull request's punch list, and the stage of a task merged into it.
import type { PrState, ReviewWithComments } from '#domain/landing/index.ts';
import type { TaskId } from '#domain/shared/index.ts';
import type { TaskStatus } from '#domain/work/lifecycle/lifecycle.ts';
import type { PlanBranch } from '#domain/work/plans/plan-branch.ts';

export interface PlanBranchMember {
  id: TaskId;
  title: string;
  status: TaskStatus;
  pr: { state: PrState; url: string | null } | null;
}

const mergedIn = (t: { status: TaskStatus; pr: { state: PrState } | null }): boolean => t.status === 'done' && t.pr?.state === 'merged';

export function readyToLand(branch: Pick<PlanBranch, 'status'>, tasks: Pick<PlanBranchMember, 'status' | 'pr'>[]): boolean {
  if (branch.status !== 'active') return false;
  return tasks.some(mergedIn) && tasks.every((t) => t.status === 'cancelled' || mergedIn(t));
}

export type ReviewVerdict = 'clean' | 'blocking';

export function reviewVerdictOf(reviews: Pick<ReviewWithComments, 'kind' | 'submitted_at'>[]): ReviewVerdict | null {
  const last = reviews.filter((r) => r.submitted_at !== null).at(-1);
  if (!last) return null;
  return last.kind === 'request_changes' ? 'blocking' : 'clean';
}

export interface PunchLine extends PlanBranchMember {
  review: ReviewVerdict | null;
  unfinished: string[];
}

const cell = (text: string): string => text.replaceAll('|', '\\|').replaceAll('\n', ' ');

export function planPrBody(branch: Pick<PlanBranch, 'name' | 'base' | 'plan_task'>, plan: string, lines: PunchLine[]): string {
  const rows = lines.map((l) =>
    [
      `#${l.id} ${cell(l.title)}`,
      l.status === 'cancelled' ? 'cancelled' : (l.pr?.url ?? 'no PR'),

      l.review ?? 'not reviewed',
      l.unfinished.length ? cell(l.unfinished.join(', ')) : 'none',
    ].join(' | '),
  );
  return [
    `Lands \`${branch.name}\` on \`${branch.base}\`: the work of #${branch.plan_task}'s plan, ${cell(plan)}.`,
    '',
    '| Task | PR | Review | Unfinished plan steps |',
    '| --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r} |`),
  ].join('\n');
}

/** Where a done task merged into a plan branch stands: waiting for the plan branch to land, landed with it, or left on an abandoned one. */
export interface PlanLanding {
  name: string;
  base: string;
  state: 'waiting' | 'landed' | 'abandoned';
}

export function planLandingOf(
  task: { status: TaskStatus; pr: { state: PrState } | null; target: string | null },
  branch: Pick<PlanBranch, 'name' | 'base' | 'status'> | undefined,
): PlanLanding | null {
  if (!branch || task.target !== branch.name || !mergedIn(task)) return null;
  const state = branch.status === 'landed' ? 'landed' : branch.status === 'abandoned' ? 'abandoned' : 'waiting';
  return { name: branch.name, base: branch.base, state };
}

export const isWaitingToLand = (t: { plan_landing?: PlanLanding | null }): boolean => t.plan_landing?.state === 'waiting';

export function planLandingText(landing: PlanLanding): string {
  switch (landing.state) {
    case 'waiting':
      return `merged into ${landing.name}, waiting for it to land`;
    case 'landed':
      return `landed on ${landing.base} with ${landing.name}`;
    case 'abandoned':
      return `merged into ${landing.name}, which was abandoned before it landed`;
  }
}
