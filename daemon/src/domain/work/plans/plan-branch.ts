// A plan branch: a branch a plan owns in a repo, which the plan's tasks target and which lands on the base as one pull request.
import { type RepoId, type TaskId, sqliteMs } from '#domain/shared/index.ts';
import { planSlug } from '#domain/work/plans/plan.ts';

export type PlanBranchStatus = 'open' | 'active' | 'conflict' | 'landing' | 'landed' | 'abandoned' | 'partly_landed';

export const PLAN_BRANCH_STATUSES: PlanBranchStatus[] = ['open', 'active', 'conflict', 'landing', 'landed', 'abandoned', 'partly_landed'];

export type PlanBranchMove =
  'cut' | 'conflict' | 'resolve' | 'open_pr' | 'close_pr' | 'land' | 'part_land' | 'retry' | 'by_hand' | 'abandon';

export const PLAN_BRANCH_MOVES: Record<PlanBranchMove, Partial<Record<PlanBranchStatus, PlanBranchStatus>>> = {
  cut: { open: 'active' },
  conflict: { active: 'conflict' },
  resolve: { conflict: 'active' },
  open_pr: { active: 'landing' },
  close_pr: { landing: 'active' },
  land: { landing: 'landed', partly_landed: 'landed' },
  part_land: { landing: 'partly_landed' },
  retry: { partly_landed: 'landing' },
  by_hand: { partly_landed: 'landing' },
  abandon: { open: 'abandoned', active: 'abandoned', conflict: 'abandoned', landing: 'abandoned', partly_landed: 'abandoned' },
};

/**
 * How a plan's plan branches land on their bases. `person`: a person merges each plan PR. `auto`: the daemon merges each
 * once its check passes. `together`: the daemon merges none until every repo's plan PR is ready, then all. `in_order`:
 * the daemon merges them one repo at a time, in the plan's order.
 */
export type LandingPolicy = 'person' | 'auto' | 'together' | 'in_order';

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
  /** The lines (added and removed) the plan branch is ahead of its base by, as the last sync measured them; null until one did. */
  ahead_lines: number | null;
  /** The plan's landing policy, the same on each of its plan branches. */
  landing_policy: LandingPolicy;
  /** Where this repo lands in an `in_order` plan, lowest first; null lands after the numbered ones, oldest plan branch first. */
  land_order: number | null;
  /** Why the daemon's last merge of the plan PR failed for good; null once it merged or a person retried. */
  land_error: string | null;
  /** The commit the plan PR's merge made on the base, once it landed; null before, or when GitHub didn't say. */
  landed_commit: string | null;
  /** The base's commit just before the plan PR's merge, which a revert goes back to; null until it landed. */
  landed_from: string | null;
  created_at: string;
  updated_at: string;
}

export const nextPlanBranchStatus = (from: PlanBranchStatus, move: PlanBranchMove): PlanBranchStatus | null =>
  PLAN_BRANCH_MOVES[move][from] ?? null;

export const planBranchStatusesFor = (move: PlanBranchMove): PlanBranchStatus[] =>
  Object.keys(PLAN_BRANCH_MOVES[move]) as PlanBranchStatus[];

export const planBranchName = (planTask: TaskId, title: string): string => `plan/${planTask}-${planSlug(title)}`;

export const LIVE_PLAN_BRANCH_STATUSES: PlanBranchStatus[] = ['open', 'active', 'conflict', 'landing', 'partly_landed'];

export const isLivePlanBranch = (branch: Pick<PlanBranch, 'status'>): boolean => LIVE_PLAN_BRANCH_STATUSES.includes(branch.status);

export function planBranchMoveError(branch: Pick<PlanBranch, 'name' | 'status'>, move: PlanBranchMove): string | null {
  if (nextPlanBranchStatus(branch.status, move)) return null;
  return `${branch.name} is ${branch.status}, so it can't ${move === 'abandon' ? 'be abandoned' : move.replace('_', ' ')}`;
}

export function planBranchOpenError(planTask: TaskId, existing: Pick<PlanBranch, 'name' | 'status'> | undefined): string | null {
  return existing ? `#${planTask}'s plan has a plan branch already: ${existing.name} (${existing.status})` : null;
}

export const reposToOpen = (ownerRepo: RepoId, taskRepos: RepoId[], opened: RepoId[]): RepoId[] =>
  [...new Set([ownerRepo, ...taskRepos])].filter((r) => !opened.includes(r));

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

export interface PlanBranchWait {
  name: string;
  base: string;
  status: 'conflict' | 'partly_landed';
}

export function planBranchWait(
  branch: Pick<PlanBranch, 'name' | 'base' | 'status'> | undefined,
  plan: Pick<PlanBranch, 'status'>[] = [],
): PlanBranchWait | null {
  if (!branch) return null;
  if (branch.status === 'conflict') return { name: branch.name, base: branch.base, status: 'conflict' };
  if ([branch, ...plan].some((b) => b.status === 'partly_landed')) return { name: branch.name, base: branch.base, status: 'partly_landed' };
  return null;
}

export function planBranchWaitText(wait: PlanBranchWait): string {
  return wait.status === 'conflict'
    ? `${wait.name} conflicts with ${wait.base}`
    : `${wait.name} is partly landed: its plan waits for a person's answer`;
}

export const planBranchConflict = (branch: Pick<PlanBranch, 'name' | 'base'>, repo: string): PlanBranchConflict => ({
  repo,
  name: branch.name,
  line: `${branch.name} conflicts with ${branch.base} and no resolve run settled it; its tasks wait until a merge of ${branch.base} into it is pushed`,
});

export const DEFAULT_PLAN_BRANCH_MAX_DAYS = 14;
export const DEFAULT_PLAN_BRANCH_MAX_LINES = 3000;

export const planBranchMaxDaysError = (days: number): string | null =>
  days >= 1 && days <= 365 ? null : 'plan_branch_max_days must be from 1 to 365';

export const planBranchMaxLinesError = (lines: number): string | null =>
  lines >= 100 && lines <= 1_000_000 ? null : 'plan_branch_max_lines must be from 100 to 1000000';

export interface PlanBranchLimits {
  days: number;
  lines: number;
}

type MeasuredPlanBranch = Pick<PlanBranch, 'name' | 'base' | 'status' | 'created_at' | 'ahead_lines'>;

export function planBranchOverLimitEntry(
  branch: MeasuredPlanBranch,
  repo: string,
  limits: PlanBranchLimits,
  now: number,
): PlanBranchConflict | null {
  if (!isLivePlanBranch(branch)) return null;
  const ageDays = Math.floor((now - sqliteMs(branch.created_at)) / 86_400_000);
  const reasons = [
    ageDays > limits.days ? `${ageDays} days old, over the limit of ${limits.days}` : null,
    branch.ahead_lines !== null && branch.ahead_lines > limits.lines
      ? `${branch.ahead_lines} lines ahead of ${branch.base}, over the limit of ${limits.lines}`
      : null,
  ].filter((r) => r !== null);
  if (!reasons.length) return null;
  return { repo, name: branch.name, line: `${branch.name} is ${reasons.join(' and ')}: land it, or split what is left` };
}

export const planBranchTarget = (branch: Pick<PlanBranch, 'name' | 'status'> | undefined): string | null =>
  branch && isLivePlanBranch(branch) ? branch.name : null;
