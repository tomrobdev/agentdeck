// Opening a task's pull request: when it finishes done, again on the PR refresh after it failed to, and when a person asks.
import type { App } from '../ports/app.ts';
import type { TaskId } from '../../domain/shared/index.ts';
import { AUTO_MERGE_LABEL, autoMergeOn } from '../../domain/landing/index.ts';
import { buildPrBody, existingPr, isPrExistsError, openPrUrl } from '../../domain/landing/index.ts';
import type { BranchPr, PrRetry } from '../../domain/landing/index.ts';
import { prNeedsPersonNotification } from '../../domain/operations/index.ts';
import { type Task, prEventsOf, prRetryFor } from '../../domain/work/index.ts';
import { errorMessage } from '../../domain/shared/index.ts';
import { prPlanFor } from '../work/plans.ts';
import { notifyLater } from '../operations/notifications.ts';
import { ActionError, requireTask, requireTaskRepo } from '../shared/input.ts';

/** Record a PR event on the task's latest run log, where `agentdeck log` and the dashboard show it. */
export function logPrEvent(app: App, taskId: TaskId, event: { url?: string; error?: string }): void {
  const run = app.runsForTask(taskId).at(-1);
  if (run) app.runLog.append(run.log_path, { type: 'agentdeck_pr', ...event });
}

/** Make sure the repo has the auto-merge label, so a PR can carry it. Throws if gh fails. */
export function ensureAutoMergeLabel(app: App, cwd: string): Promise<void> {
  return app.codeHost.ensureLabel(cwd, AUTO_MERGE_LABEL);
}

/**
 * For a task that has just finished done: push its branch and open a PR if its repo's pr_mode asks for one.
 * Never throws and never changes the task's status: a failure is logged as an `agentdeck_pr` event and returned.
 */
export async function openPullRequest(app: App, task: Task): Promise<{ url?: string; error?: string }> {
  const repo = app.getRepo(task.repo_id);
  const branch = task.checkout?.branch;
  if (!repo || repo.pr_mode === 'off' || !branch) return {};
  try {
    await app.codeHost.push(repo.path, branch);
    // A task retried while its PR is still open keeps that PR; the push above updated it.
    // Once that PR is merged or closed, the new commits need a new PR.
    const open = openPrUrl(task.pr);
    if (open) return { url: open };
    // A PR the daemon may merge carries the label. If the repo can't have it, the PR opens without it and waits for a person.
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
        base: repo.base_branch,
        head: branch,
        title: task.title,
        body: buildPrBody(task, app.runsForTask(task.id), prPlanFor(app, task)),
        draft: repo.pr_mode === 'draft',
        labels: labelled ? [AUTO_MERGE_LABEL.name] : [],
      })
      .then(
        (url) => ({ url, state: 'open' as const }),
        (err) => existingPrOf(app, cwd, branch, err),
      );
    // Recorded whatever the task's status: GitHub has the PR even if the task was retried while it opened.
    for (const event of prEventsOf(pr)) app.recordPr(task.id, event);
    logPrEvent(app, task.id, { url: pr.url });
    return { url: pr.url };
  } catch (err) {
    const error = errorMessage(err);
    // Tell dependents the PR won't appear on its own. A PR that is already open stays open.
    app.recordPr(task.id, { type: 'failed', error });
    logPrEvent(app, task.id, { error });
    return { error };
  }
}

/**
 * `gh pr create` failed with `err`. When that is because the branch has a PR already (a daemon stopped between opening it
 * and recording it, or a retry while it opened kept it from being recorded), the PR GitHub has. Otherwise, or when GitHub
 * can't say which PR, throws `err`.
 */
async function existingPrOf(app: App, cwd: string, branch: string, err: unknown): Promise<BranchPr> {
  if (!isPrExistsError(errorMessage(err))) throw err;
  const found = existingPr(await app.codeHost.prsForBranch(cwd, branch).catch(() => []));
  if (!found) throw err;
  return found;
}

/**
 * For a done task whose PR failed to open, in a repo with a PR mode: whether the PR refresh opens it again at `now`, from the
 * failures its history records since it finished. Null for any other task.
 */
function prRetryOf(app: App, task: Task, now: number): PrRetry | null {
  return prRetryFor(task, app.getRepo(task.repo_id), app.eventsForTask(task.id), now);
}

/**
 * On the PR refresh: open again each done task's PR that failed to open, once its wait is over (`prRetry`: at most
 * PR_OPEN_RETRIES times, each wait twice the last). When the last retry fails, a person is told, with its error; the task
 * then needs a person (`agentdeck open-pr`). A PR that failed to open before the task finished is not counted: a task that
 * finishes again opens its PR as its follow-up. Returns how many opened.
 */
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

/** What a person's `open-pr` came to: the PR's url. */
export interface OpenTaskPrResult {
  url: string;
}

/**
 * A person opens a done task's PR: one that failed to open (whether or not the PR refresh still retries it), never opened, or
 * was closed. Pushes the branch first, as when the task finished. Refused when the repo's PR mode is off, the PR is open or
 * merged, or the task has no branch; a failure is recorded on the task like any other and comes back as the error.
 */
export async function openTaskPr(app: App, id: TaskId): Promise<OpenTaskPrResult> {
  const task = requireTask(app, id);
  if (task.status !== 'done') throw new ActionError(`#${id} is ${task.status}; only a done task's PR can be opened`);
  const repo = requireTaskRepo(app, task);
  if (repo.pr_mode === 'off') throw new ActionError(`${repo.name}'s PR mode is off: agentdeck repo set ${repo.name} pr_mode ready`);
  if (task.pr?.state === 'open') throw new ActionError(`#${id}'s PR is open already: ${task.pr.url}`);
  if (task.pr?.state === 'merged') throw new ActionError(`#${id}'s PR is merged`);
  if (!task.checkout?.branch) throw new ActionError(`#${id} has no branch`);
  const { url, error } = await openPullRequest(app, task);
  if (!url) throw new ActionError(`could not open the PR: ${error ?? 'unknown error'}`);
  return { url };
}
