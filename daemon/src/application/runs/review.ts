// The review run of a done task: claude reads the task's changes against its Goal, Definition of done and linked plan
// steps with read-only tools, and answers with a summary and findings. The daemon stores that as a submitted review by
// the review run, and on blocking findings retries the task once with the review as its note. It takes a slot and uses
// no attempt (domain/runs/review.ts).
import type { App } from '../ports/app.ts';
import type { TaskId } from '../../domain/shared/index.ts';
import type { PromptPlan } from '../../domain/runs/index.ts';
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
} from '../../domain/runs/index.ts';
import type { Task } from '../../domain/work/index.ts';
import { errorMessage } from '../../domain/shared/index.ts';
import { type OpenedRun, endTaskRun, openTaskRun, startTaskRun } from './claude-run.ts';
import { planForRun } from '../work/plans.ts';
import { settle } from '../landing/settle.ts';

/**
 * What a review run came to. `clean`: its review has no blocking finding; `retried`: one blocks, and the task went back
 * to work with the review as its note; `left`: one blocks, but a review run retried the task before, so it waits in
 * review for a person; `garbage`: its answer could not be read, so it left no review; `stale`: the task stopped being
 * done, or another review run read these changes, before it started; `cancelled`: the task stopped being done while it ran.
 */
export interface ReviewReport {
  outcome: 'clean' | 'retried' | 'left' | 'garbage' | 'stale' | 'failed' | 'rate_limited' | 'cancelled';
  reason?: string;
}

/** A done task and the changes a review run of it reads: its head, where its branch left the base, and their patch-id. */
export interface ReviewTarget {
  task: Task;
  head: string;
  from: string;
  diffHash: string;
}

/** The changes a review run of `task` would read, or null when its branch, its base or their patch-id can't be found. */
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

/**
 * The done task a review run should start for next, with the changes it reads (`reviewable`), or undefined when none
 * may. A task whose changes can't be read is passed over.
 */
export async function nextReviewable(app: App): Promise<ReviewTarget | undefined> {
  for (const task of app.reviewCandidates()) {
    let target: ReviewTarget | null = null;
    try {
      target = await reviewTarget(app, task);
    } catch {
      continue; // git could not read the branch: the next tick looks again
    }
    const now = target && app.getTask(task.id);
    const repo = now && app.getRepo(now.repo_id);
    if (target && now && repo && reviewable(now, app.runsForTask(now.id), repo, target.diffHash)) return { ...target, task: now };
  }
  return undefined;
}

/**
 * Run a review run for a done task's changes. The diff was worked out before, so whether one may start is asked again
 * here, with no await between that and the run row opening: a second call for the same changes, while the first is
 * being set up, finds its row and starts nothing. Never throws: a failure ends the row failed and leaves no review,
 * and the row's diff_hash keeps the next tick from starting another for the same changes.
 */
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
    // Merged, retried or sent back by a person: the changes it reads are no longer the ones waiting to merge.
    cancelled: () => app.getTask(task.id)?.status !== 'done',
  });

  const { end, fields } = ran;
  if (end.kind === 'cancelled') {
    await endTaskRun(app, opened, 'cancelled', 'the task is no longer done', fields);
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
  // The row ends after the review is stored: a retried task is not claimed while its review run is open.
  try {
    return await settleReview(app, task.id, target, outcome);
  } finally {
    await endTaskRun(app, opened, 'done', undefined, fields);
  }
}

const reviewLogText = ({ record, retry }: ReviewOutcome): string =>
  record.kind === 'comment'
    ? `Clean: no finding blocks (${record.comments.length} comment(s))`
    : retry
      ? 'Changes requested: the task goes back to work with the review as its note'
      : 'Changes requested, but a review run retried the task before: it waits in review for a person';

/**
 * Store the review, after the retry when it blocks, as a person's Request changes retries before it submits: the
 * worker's next prompt reads a review submitted at or after its retry as that retry's own (`isReviewRetry`). Nothing is
 * stored when the task stopped being done meanwhile.
 */
async function settleReview(app: App, id: TaskId, target: ReviewTarget, { record, retry }: ReviewOutcome): Promise<ReviewReport> {
  if (retry) {
    if (!(await settle(app, id, { type: 'review_retry' }, { reason: retry }))) return { outcome: 'stale' };
  } else if (app.getTask(id)?.status !== 'done') {
    return { outcome: 'stale' };
  }
  const review = app.addRunReview(id, record.kind, record.body, { head_commit: target.head, diff_hash: target.diffHash });
  for (const c of record.comments) app.addComment({ review_id: review.id, ...c, head_commit: target.head });
  if (record.kind === 'comment') return { outcome: 'clean' };
  return retry ? { outcome: 'retried', reason: retry } : { outcome: 'left' };
}
