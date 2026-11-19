// A plan branch: a branch a plan owns in a repo, which the plan's tasks target and which lands on the base as one pull request.
import type { RepoId, TaskId } from '#domain/shared/index.ts';
import { planSlug } from '#domain/work/plans/plan.ts';

export type PlanBranchStatus = 'open' | 'active' | 'conflict' | 'landing' | 'landed' | 'abandoned' | 'partly_landed';

export const PLAN_BRANCH_STATUSES: PlanBranchStatus[] = ['open', 'active', 'conflict', 'landing', 'landed', 'abandoned', 'partly_landed'];

export type PlanBranchMove = 'cut' | 'conflict' | 'resolve' | 'open_pr' | 'close_pr' | 'land' | 'abandon';

export const PLAN_BRANCH_MOVES: Record<PlanBranchMove, Partial<Record<PlanBranchStatus, PlanBranchStatus>>> = {
  cut: { open: 'active' },
  conflict: { active: 'conflict' },
  resolve: { conflict: 'active' },
  open_pr: { active: 'landing' },
  close_pr: { landing: 'active' },
  land: { landing: 'landed' },
  abandon: { open: 'abandoned', active: 'abandoned', conflict: 'abandoned', landing: 'abandoned' },
};

export interface PlanBranch {
  id: number;
  plan_task: TaskId;
  repo_id: RepoId;
  name: string;
  base: string;
  status: PlanBranchStatus;
  head_commit: string | null;
  pr_url: string | null;
  created_at: string;
  updated_at: string;
}

export const nextPlanBranchStatus = (from: PlanBranchStatus, move: PlanBranchMove): PlanBranchStatus | null =>
  PLAN_BRANCH_MOVES[move][from] ?? null;

export const planBranchStatusesFor = (move: PlanBranchMove): PlanBranchStatus[] =>
  Object.keys(PLAN_BRANCH_MOVES[move]) as PlanBranchStatus[];

export const planBranchName = (planTask: TaskId, title: string): string => `plan/${planTask}-${planSlug(title)}`;

const LIVE: PlanBranchStatus[] = ['open', 'active', 'conflict', 'landing'];

export const isLivePlanBranch = (branch: Pick<PlanBranch, 'status'>): boolean => LIVE.includes(branch.status);

export function planBranchMoveError(branch: Pick<PlanBranch, 'name' | 'status'>, move: PlanBranchMove): string | null {
  if (nextPlanBranchStatus(branch.status, move)) return null;
  return `${branch.name} is ${branch.status}, so it can't ${move === 'abandon' ? 'be abandoned' : move.replace('_', ' ')}`;
}

export function planBranchOpenError(planTask: TaskId, existing: Pick<PlanBranch, 'name' | 'status'> | undefined): string | null {
  return existing ? `#${planTask}'s plan has a plan branch already: ${existing.name} (${existing.status})` : null;
}

export interface PlanBranchTask {
  id: TaskId;
  target: string | null;
  started: boolean;
  running: boolean;
}

export const tasksToTarget = (tasks: PlanBranchTask[]): TaskId[] => tasks.filter((t) => t.target === null && !t.started).map((t) => t.id);

export const tasksBackToBase = (tasks: PlanBranchTask[], name: string): TaskId[] =>
  tasks.filter((t) => t.target === name && !t.started).map((t) => t.id);

export function abandonRunningError(name: string, tasks: PlanBranchTask[]): string | null {
  const running = tasks.filter((t) => t.target === name && t.running).map((t) => `#${t.id}`);
  if (!running.length) return null;
  const one = running.length === 1;
  return `${running.join(', ')} ${one ? 'is' : 'are'} running on ${name}; abandon it once ${one ? 'it ends' : 'they end'}`;
}

export const needsCut = (branch: Pick<PlanBranch, 'status'>): boolean => branch.status === 'open';

export const planBranchTarget = (branch: Pick<PlanBranch, 'name' | 'status'> | undefined): string | null =>
  branch && isLivePlanBranch(branch) ? branch.name : null;
