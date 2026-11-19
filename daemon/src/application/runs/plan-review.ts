// The plan review run: once a plan PR opens, claude reads the plan branch's whole diff against its base and the plan's steps, and its verdict is left on the plan PR.
import type { App } from '#application/ports/app.ts';
import type { Repo } from '#domain/repos/index.ts';
import {
  REVIEW_DENIED_TOOLS,
  REVIEW_MAX_TURNS,
  REVIEW_TOOLS,
  buildPlanReviewPrompt,
  parseReviewAnswer,
  planReviewComment,
  planReviewSystemPrompt,
  reviewSchemaArgs,
  reviewVerdict,
} from '#domain/runs/index.ts';
import { errorMessage } from '#domain/shared/index.ts';
import { type PlanBranch, type PlanReviewState, type Task, planReviewDue, planReviewMoveOf } from '#domain/work/index.ts';
import { type OpenedRun, endTaskRun, openTaskRun, startTaskRun } from '#application/runs/claude-run.ts';

export interface PlanReviewReport {
  outcome: PlanReviewState | 'deferred' | 'stale';
  reason?: string;
}

const reviewing = new Set<number>();

export function nextPlanReview(app: App): PlanBranch | null {
  const open = new Set(app.listRepos().flatMap((r) => (r.paused_reason ? [] : [r.id])));
  return app.landingPlanBranches().find((b) => open.has(b.repo_id) && !reviewing.has(b.id) && planReviewDue(b)) ?? null;
}

interface ReviewPlace {
  branch: PlanBranch;
  repo: Repo;
  owner: Task;
  worktree: string;
}

export async function runPlanReview(app: App, branch: PlanBranch): Promise<PlanReviewReport> {
  if (reviewing.has(branch.id)) return { outcome: 'deferred', reason: 'a plan review of it is running' };
  reviewing.add(branch.id);
  try {
    const fresh = app.planBranchNamed(branch.repo_id, branch.name);
    const repo = app.getRepo(branch.repo_id);
    const owner = app.getTask(branch.plan_task);
    if (!fresh || !repo || !owner || !planReviewDue(fresh)) return { outcome: 'stale' };
    return await app.workspace.withScratchCheckout(repo, fresh.name, async (checkout) => {
      if ('error' in checkout) return { outcome: 'deferred' as const, reason: checkout.error };
      return reviewIn(app, { branch: fresh, repo, owner, worktree: checkout.path });
    });
  } catch (err) {
    return { outcome: 'deferred', reason: errorMessage(err) };
  } finally {
    reviewing.delete(branch.id);
  }
}

async function reviewIn(app: App, at: ReviewPlace): Promise<PlanReviewReport> {
  const head = (await app.workspace.head(at.worktree))?.sha;
  const from = head && (await app.workspace.diffBase(at.repo.path, at.branch.base, head))?.sha;
  if (!head || !from) return { outcome: 'deferred', reason: `${at.branch.name} has no diff against ${at.branch.base} to read` };
  const opened = openTaskRun(app, at.owner, 'plan_review');
  try {
    return await reviewOpened(app, at, opened, { from, head });
  } catch (err) {
    const reason = errorMessage(err);
    await endTaskRun(app, opened, 'failed', reason);
    return { outcome: 'deferred', reason };
  }
}

async function reviewOpened(
  app: App,
  at: ReviewPlace,
  opened: OpenedRun,
  range: { from: string; head: string },
): Promise<PlanReviewReport> {
  const { branch, repo, owner, worktree } = at;
  const own = app.ownPlan(branch.plan_task);
  const prompt = buildPlanReviewPrompt(branch, {
    plan: own ? { name: own.name, html: own.html } : null,
    tasks: app.tasksOnTarget(branch.repo_id, branch.name),
    ...range,
  });
  const ran = await startTaskRun(app, owner, {
    kind: 'plan_review',
    repo,
    worktree,
    prompt,
    opened,
    maxTurns: REVIEW_MAX_TURNS,
    systemPrompt: planReviewSystemPrompt(),
    tools: REVIEW_TOOLS,
    disallowed: REVIEW_DENIED_TOOLS,
    args: reviewSchemaArgs(),
    cancelled: () => !stillDue(app, branch),
  });
  const { end, fields } = ran;
  if (end.kind === 'cancelled' || end.kind === 'rate_limited') {
    await endTaskRun(app, opened, end.kind, end.kind === 'cancelled' ? 'the plan PR is no longer open' : end.reason, fields);
    return { outcome: 'deferred', reason: end.kind };
  }
  const answer = end.kind === 'finished' ? parseReviewAnswer(end.result.structured_output ?? end.result.result) : null;
  const reason = end.kind === 'finished' ? 'the plan review run gave no answer that could be read' : end.reason;
  const summary = answer ? planReviewComment(answer) : null;
  const recorded = app.recordPlanReview(branch, planReviewMoveOf(answer ? reviewVerdict(answer) : null), { head: range.head, summary });
  await endTaskRun(app, opened, answer ? 'done' : 'failed', answer ? undefined : reason, fields);
  if (!recorded?.review) return { outcome: 'stale' };
  if (summary && branch.pr_url) {
    await app.codeHost.commentOnPr(branch.pr_url, repo.path, summary).catch((err) => {
      app.runLog.event(opened.log, { type: 'agentdeck_error', text: `comment on the plan PR: ${errorMessage(err)}` });
    });
  }
  return answer ? { outcome: recorded.review } : { outcome: recorded.review, reason };
}

const stillDue = (app: App, branch: PlanBranch): boolean => {
  const now = app.planBranchNamed(branch.repo_id, branch.name);
  return now !== undefined && planReviewDue(now) && now.pr_url === branch.pr_url;
};
