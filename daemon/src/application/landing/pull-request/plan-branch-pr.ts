// A plan branch's pull request: opened into its base once every task on it has merged, then landed as its plan's landing policy says.
import type { App } from '#application/ports/app.ts';
import { type BranchPr, existingPr, isPrExistsError } from '#domain/landing/index.ts';
import { errorMessage } from '#domain/shared/index.ts';
import {
  type PlanBranch,
  type PunchLine,
  type Task,
  parsePlan,
  planBranchSyncDue,
  planPrBody,
  readyToLand,
  reviewVerdictOf,
  unfinishedSteps,
} from '#domain/work/index.ts';
import { followedSteps } from '#application/work/plans.ts';
import { landPlanBranches } from '#application/landing/pull-request/plan-landing.ts';

export const LAND_RETRY_MINUTES = 5;

export function isReadyToLand(app: App, branch: PlanBranch): boolean {
  return readyToLand(branch, app.tasksOnTarget(branch.repo_id, branch.name));
}

export function nextPlanBranchToLand(app: App, now: number, busy: (branch: PlanBranch) => boolean): PlanBranch | null {
  const open = new Set(app.listRepos().flatMap((r) => (r.paused_reason || r.pr_mode === 'off' ? [] : [r.id])));
  return (
    app
      .syncedPlanBranches()
      .find((b) => open.has(b.repo_id) && !busy(b) && planBranchSyncDue(b, now, LAND_RETRY_MINUTES) && isReadyToLand(app, b)) ?? null
  );
}

function punchLine(app: App, task: Task): PunchLine {
  const steps = task.status === 'cancelled' ? null : followedSteps(app, task);
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    pr: task.pr ? { state: task.pr.state, url: task.pr.url } : null,
    review: reviewVerdictOf(app.reviewsForTask(task.id)),
    unfinished: steps ? unfinishedSteps(steps).map((s) => s.id ?? s.title) : [],
  };
}

export function planPrText(app: App, branch: PlanBranch): { title: string; body: string } {
  const html = app.ownPlan(branch.plan_task)?.html;
  const plan = (html && parsePlan(html)?.title) || `#${branch.plan_task}'s plan`;
  const lines = app.tasksOnTarget(branch.repo_id, branch.name).map((t) => punchLine(app, t));
  return { title: plan, body: planPrBody(branch, plan, lines) };
}

export async function openPlanBranchPr(app: App, branch: PlanBranch): Promise<{ url?: string; error?: string }> {
  const repo = app.getRepo(branch.repo_id);
  if (!repo) return { error: 'its repo is gone' };
  const fresh = app.planBranchNamed(repo.id, branch.name);
  if (!fresh || !isReadyToLand(app, fresh)) return { error: `${branch.name} is not ready to land` };
  const { title, body } = planPrText(app, fresh);
  try {
    const pr: BranchPr = await app.codeHost
      .createPr({ cwd: repo.path, base: fresh.base, head: fresh.name, title, body, draft: false, labels: [] })
      .then(
        (url) => ({ url, state: 'open' as const }),
        (err) => existingPlanPr(app, repo.path, fresh.name, err),
      );
    if (!app.openPlanBranchPr(fresh.id, pr.url)) return { error: `${fresh.name} changed while its PR opened` };
    return { url: pr.url };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

async function existingPlanPr(app: App, cwd: string, branch: string, err: unknown): Promise<BranchPr> {
  if (!isPrExistsError(errorMessage(err))) throw err;
  const found = existingPr(await app.codeHost.prsForBranch(cwd, branch).catch(() => []));
  if (found?.state !== 'open') throw err;
  return found;
}

export const refreshPlanBranchPrs = landPlanBranches;
