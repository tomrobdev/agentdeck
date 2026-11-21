// Opening a task's pull request: when it finishes done, again on the PR refresh after it failed to, and when a person asks.
import type { App } from '#application/ports/app.ts';
import type { TaskId } from '#domain/shared/index.ts';
import { AUTO_MERGE_LABEL, autoMergeOn, codeCommentsOver, codeCommentsText, countCodeComments, prFrom } from '#domain/landing/index.ts';
import type { Repo } from '#domain/repos/index.ts';
import { buildPrBody, existingPr, isPrExistsError, openPrUrl } from '#domain/landing/index.ts';
import type { BranchPr, PrRetry } from '#domain/landing/index.ts';
import { prNeedsPersonNotification } from '#domain/operations/index.ts';
import { type Task, prEventsOf, prRetryFor, targetOf } from '#domain/work/index.ts';
import { errorMessage } from '#domain/shared/index.ts';
import { prPlanFor } from '#application/work/plans.ts';
import { notifyLater } from '#application/operations/notifications.ts';
import { movePr } from '#application/landing/moves.ts';
import { ActionError, requireTask, requireTaskRepo } from '#application/shared/input.ts';

export function logPrEvent(app: App, taskId: TaskId, event: { url?: string; error?: string }): void {
  const run = app.runsForTask(taskId).at(-1);
  if (run) app.runLog.append(run.log_path, { type: 'agentdeck_pr', ...event });
}

export function ensureAutoMergeLabel(app: App, cwd: string): Promise<void> {
  return app.codeHost.ensureLabel(cwd, AUTO_MERGE_LABEL);
}

async function commentsOver(app: App, repo: Repo, target: string, branch: string): Promise<string | null> {
  const added = await app.workspace.addedLines(repo.path, target, branch);
  const comments = added && countCodeComments(added);
  return comments && codeCommentsOver(comments, repo) ? codeCommentsText(comments, repo) : null;
}

export async function openPullRequest(app: App, task: Task): Promise<{ url?: string; error?: string }> {
  const repo = app.getRepo(task.repo_id);
  const branch = task.checkout?.branch;
  if (!repo || repo.pr_mode === 'off' || !branch) return {};
  const target = targetOf(task, repo);
  try {
    const over = commentsOver(app, repo, target, branch).catch(() => null);
    await app.codeHost.push(repo.path, branch);
    const open = openPrUrl(task.pr);
    if (open) return { url: open };
    const labelled =
      autoMergeOn(task, repo) &&
      (await ensureAutoMergeLabel(app, repo.path).then(
        () => true,
        () => false,
      ));
    const cwd = task.checkout?.worktree ?? repo.path;
    const pr: BranchPr = await app.codeHost
      .createPr({
        cwd,
        base: target,
        head: branch,
        title: task.title,
        body: buildPrBody(task, app.runsForTask(task.id), prPlanFor(app, task), await over, app.issueOf(task.id)?.number ?? null),
        draft: repo.pr_mode === 'draft',
        labels: labelled ? [AUTO_MERGE_LABEL.name] : [],
      })
      .then(
        (url) => ({ url, state: 'open' as const }),
        (err) => existingPrOf(app, cwd, branch, err),
      );
    let from = prFrom(task.pr?.state);
    for (const event of prEventsOf(pr)) from = movePr(app, task, event, undefined, from) ?? from;
    logPrEvent(app, task.id, { url: pr.url });
    return { url: pr.url };
  } catch (err) {
    const error = errorMessage(err);
    movePr(app, task, { type: 'failed', error });
    logPrEvent(app, task.id, { error });
    return { error };
  }
}

async function existingPrOf(app: App, cwd: string, branch: string, err: unknown): Promise<BranchPr> {
  if (!isPrExistsError(errorMessage(err))) throw err;
  const found = existingPr(await app.codeHost.prsForBranch(cwd, branch).catch(() => []));
  if (!found) throw err;
  return found;
}

function prRetryOf(app: App, task: Task, now: number): PrRetry | null {
  return prRetryFor(task, app.getRepo(task.repo_id), app.eventsForTask(task.id), now);
}

export async function retryFailedPrs(app: App, log: (msg: string) => void = () => {}, now: number = Date.now()): Promise<number> {
  let opened = 0;
  for (const task of app.failedPrTasks()) {
    const retry = prRetryOf(app, task, now);
    if (retry?.state !== 'due') continue;
    const { url, error } = await openPullRequest(app, task);
    if (url) {
      opened++;
      log(`task ${task.id}: PR opened after ${retry.failures} failed ${retry.failures === 1 ? 'try' : 'tries'}: ${url}`);
      continue;
    }
    if (!error) continue;
    const after = prRetryOf(app, task, now);
    log(`task ${task.id}: could not open the PR again: ${error}`);
    if (after?.state === 'person') notifyLater(app, prNeedsPersonNotification(task, after.failures, after.error));
  }
  return opened;
}

export interface OpenTaskPrResult {
  url: string;
}

export async function openTaskPr(app: App, id: TaskId): Promise<OpenTaskPrResult> {
  const task = requireTask(app, id);
  if (task.status !== 'done') throw new ActionError(`#${id} is ${task.status}; only a done task's PR can be opened`);
  const repo = requireTaskRepo(app, task);
  if (repo.pr_mode === 'off') throw new ActionError(`${repo.name}'s PR mode is off: agentdeck repo set ${repo.name} pr_mode ready`);
  if (task.pr?.state === 'open') throw new ActionError(`#${id}'s PR is open already: ${task.pr.url}`);
  if (task.pr?.state === 'merged') throw new ActionError(`#${id}'s PR is merged`);
  if (!task.checkout?.branch) throw new ActionError(`#${id} has no branch`);
  const { url, error } = await openPullRequest(app, task);
  if (!url) throw new ActionError(`could not open the PR: ${error ?? 'unknown error'}`, undefined, 'upstream');
  return { url };
}
