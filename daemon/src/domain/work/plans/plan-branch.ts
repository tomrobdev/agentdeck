// A plan branch: a branch a plan owns in a repo, which the plan's tasks target and which lands on the base as one pull request.
import { type RepoId, type TaskId, sqliteMs } from '#domain/shared/index.ts';
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
  synced_at: string | null;
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

export const DEFAULT_PLAN_BRANCH_SYNC_MINUTES = 60;

export const planBranchSyncMinutesError = (minutes: number): string | null =>
  minutes >= 5 && minutes <= 7 * 24 * 60 ? null : 'plan_branch_sync_minutes must be from 5 to 10080 (a week)';

const SYNCED: PlanBranchStatus[] = ['active', 'conflict'];

export function planBranchSyncDue(branch: Pick<PlanBranch, 'status' | 'synced_at'>, now: number, everyMinutes: number): boolean {
  if (!SYNCED.includes(branch.status)) return false;
  return branch.synced_at === null || now - sqliteMs(branch.synced_at) >= everyMinutes * 60_000;
}

export const mayResolvePlanBranch = (branch: Pick<PlanBranch, 'status'>, repo: { auto_resolve: boolean }): boolean =>
  branch.status === 'active' && repo.auto_resolve;

export type PlanBranchSyncOutcome = 'up_to_date' | 'clean' | 'resolved' | 'conflict';

export function planBranchSyncMove(branch: Pick<PlanBranch, 'status'>, outcome: PlanBranchSyncOutcome): PlanBranchMove | null {
  if (outcome === 'conflict') return branch.status === 'active' ? 'conflict' : null;
  return branch.status === 'conflict' ? 'resolve' : null;
}

export interface PlanBranchConflict {
  repo: string;
  name: string;
  line: string;
}

export const planBranchWait = (branch: Pick<PlanBranch, 'name' | 'base' | 'status'> | undefined): { name: string; base: string } | null =>
  branch?.status === 'conflict' ? { name: branch.name, base: branch.base } : null;

export const planBranchConflict = (branch: Pick<PlanBranch, 'name' | 'base'>, repo: string): PlanBranchConflict => ({
  repo,
  name: branch.name,
  line: `${branch.name} conflicts with ${branch.base} and no resolve run settled it; its tasks wait until a merge of ${branch.base} into it is pushed`,
});

export const planBranchTarget = (branch: Pick<PlanBranch, 'name' | 'status'> | undefined): string | null =>
  branch && isLivePlanBranch(branch) ? branch.name : null;
