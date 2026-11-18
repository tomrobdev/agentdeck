// The review run of a done task: claude reads the task's changes against its Goal, Definition of done and linked plan steps with read-only tools, and answers with a summary and findings.
import type { App } from '#application/ports/app.ts';
import type { TaskId } from '#domain/shared/index.ts';
import type { PromptPlan } from '#domain/runs/index.ts';
import {
  REVIEW_DENIED_TOOLS,
  REVIEW_MAX_TURNS,
  REVIEW_TOOLS,
  type ReviewOutcome,
  buildReviewPrompt,
  parseReviewAnswer,
  reviewOutcome,
  reviewSchemaArgs,
  reviewSystemPrompt,
  reviewable,
} from '#domain/runs/index.ts';
import type { Task } from '#domain/work/index.ts';
import { errorMessage } from '#domain/shared/index.ts';
import { type OpenedRun, endTaskRun, openTaskRun, startTaskRun } from '#application/runs/claude-run.ts';
import { planForRun } from '#application/work/plans.ts';
import { settle } from '#application/landing/settle.ts';

export interface ReviewReport {
  outcome: 'clean' | 'retried' | 'left' | 'garbage' | 'stale' | 'failed' | 'rate_limited' | 'cancelled';
  reason?: string;
}

export interface ReviewTarget {
  task: Task;
  head: string;
  from: string;
  diffHash: string;
}

async function reviewTarget(app: App, task: Task): Promise<ReviewTarget | null> {
  const repo = app.getRepo(task.repo_id);
  const branch = task.checkout?.branch;
  if (!repo || !branch) return null;
  const head = await app.workspace.branchHead(repo.path, branch);
  if (!head) return null;
  const [base, diffHash] = await Promise.all([
    app.workspace.diffBase(repo.path, repo.base_branch, head),
    app.workspace.diffHash(repo.path, repo.base_branch, head),
  ]);
  return base && diffHash ? { task, head, from: base.sha, diffHash } : null;
}

export async function nextReviewable(app: App): Promise<ReviewTarget | undefined> {
  for (const task of app.reviewCandidates()) {
    let target: ReviewTarget | null = null;
    try {
      target = await reviewTarget(app, task);
    } catch {
      continue;
    }
    const now = target && app.getTask(task.id);
    const repo = now && app.getRepo(now.repo_id);
    if (target && now && repo && reviewable(now, app.runsForTask(now.id), repo, target.diffHash)) return { ...target, task: now };
  }
  return undefined;
}

export async function runReview(app: App, target: ReviewTarget): Promise<ReviewReport> {
  const task = app.getTask(target.task.id);
  const repo = task && app.getRepo(task.repo_id);
  if (!task || !repo || !reviewable(task, app.runsForTask(task.id), repo, target.diffHash)) return { outcome: 'stale' };
  const opened = openTaskRun(app, task, 'review', target.diffHash);
  try {
    return await runOpened(app, { ...target, task }, opened);
  } catch (err) {
    const reason = errorMessage(err);
    await endTaskRun(app, opened, 'failed', reason);
    return { outcome: 'failed', reason };
  }
}

async function runOpened(app: App, target: ReviewTarget, opened: OpenedRun): Promise<ReviewReport> {
  const { task } = target;
  const { log } = opened;
  const repo = app.getRepo(task.repo_id);
  if (!repo) throw new Error(`repo ${task.repo_id} not found`);
  const wt = await app.workspace.prepareCheckout(repo, task);
  if (wt.path !== task.checkout?.worktree) app.setCheckout(task.id, { branch: wt.branch, worktree: wt.path });

  let plan: PromptPlan | null = null;
  try {
    plan = planForRun(app, task);
  } catch (err) {
    app.runLog.event(log, { type: 'agentdeck_error', text: `read plan: ${errorMessage(err)}` });
  }
  const prompt = buildReviewPrompt(task, { plan, from: target.from, head: target.head });

  const ran = await startTaskRun(app, task, {
    kind: 'review',
    repo,
    worktree: wt.path,
    prompt,
    opened,
    maxTurns: REVIEW_MAX_TURNS,
    systemPrompt: reviewSystemPrompt(),
    tools: REVIEW_TOOLS,
    disallowed: REVIEW_DENIED_TOOLS,
    args: reviewSchemaArgs(),
    cancelled: () => !reviewStillWanted(app.getTask(task.id)),
  });

  const { end, fields } = ran;
  if (end.kind === 'cancelled') {
    await endTaskRun(app, opened, 'cancelled', 'the task is no longer waiting for a review', fields);
    return { outcome: 'cancelled' };
  }
  if (end.kind === 'rate_limited' || end.kind === 'failed') {
    await endTaskRun(app, opened, end.kind, end.reason, fields);
    return { outcome: end.kind, reason: end.reason };
  }
  const answer = parseReviewAnswer(end.result.structured_output ?? end.result.result);
  if (!answer) {
    const reason = 'the review run gave no answer that could be read';
    app.runLog.event(log, { type: 'agentdeck_error', text: reason });
    await endTaskRun(app, opened, 'failed', reason, fields);
    return { outcome: 'garbage', reason };
  }
  const outcome = reviewOutcome(answer, app.eventsForTask(task.id));
  app.runLog.event(log, { type: 'agentdeck_review', text: reviewLogText(outcome) });
  try {
    return await settleReview(app, task.id, target, outcome);
  } finally {
    await endTaskRun(app, opened, 'done', undefined, fields);
  }
}

const reviewStillWanted = (task: Task | undefined): boolean => task?.status === 'done' && task.pr?.state !== 'merged';

const reviewLogText = ({ record, retry }: ReviewOutcome): string =>
  record.kind === 'comment'
    ? `Clean: no finding blocks (${record.comments.length} comment(s))`
    : retry
      ? 'Changes requested: the task goes back to work with the review as its note'
      : 'Changes requested, but a review run retried the task before: it waits in review for a person';

async function settleReview(app: App, id: TaskId, target: ReviewTarget, { record, retry }: ReviewOutcome): Promise<ReviewReport> {
  if (retry) {
    if (!(await settle(app, id, { type: 'review_retry' }, { reason: retry }))) return { outcome: 'stale' };
  } else if (!reviewStillWanted(app.getTask(id))) {
    return { outcome: 'stale' };
  }
  const review = app.addRunReview(id, record.kind, record.body, { head_commit: target.head, diff_hash: target.diffHash });
  for (const c of record.comments) app.addComment({ review_id: review.id, ...c, head_commit: target.head });
  if (record.kind === 'comment') return { outcome: 'clean' };
  return retry ? { outcome: 'retried', reason: retry } : { outcome: 'left' };
}
