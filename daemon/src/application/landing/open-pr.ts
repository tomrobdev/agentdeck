// Opening a task's pull request when it finishes done.
import { github } from '../../adapters/github.ts';
import { appendEvent } from '../../adapters/run-log.ts';
import type { App } from '../ports/app.ts';
import type { TaskId } from '../../domain/shared/index.ts';
import { AUTO_MERGE_LABEL, autoMergeOn } from '../../domain/landing/index.ts';
import { buildPrBody, openPrUrl } from '../../domain/landing/index.ts';
import type { Task } from '../../domain/work/index.ts';
import { errorMessage } from '../../domain/shared/index.ts';
import { prPlanFor } from '../work/plans.ts';

/** Record a PR event on the task's latest run log, where `agentdeck log` and the dashboard show it. */
export function logPrEvent(app: App, taskId: TaskId, event: { url?: string; error?: string }): void {
  const run = app.runsForTask(taskId).at(-1);
  if (run) appendEvent(run.log_path, { type: 'agentdeck_pr', ...event });
}

/** Make sure the repo has the auto-merge label, so a PR can carry it. Throws if gh fails. */
export function ensureAutoMergeLabel(cwd: string): Promise<void> {
  return github.ensureLabel(cwd, AUTO_MERGE_LABEL);
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
    await github.push(repo.path, branch);
    // A task retried while its PR is still open keeps that PR; the push above updated it.
    // Once that PR is merged or closed, the new commits need a new PR.
    const open = openPrUrl(task.pr);
    if (open) return { url: open };
    // A PR the daemon may merge carries the label. If the repo can't have it, the PR opens without it and waits for a person.
    const labelled =
      autoMergeOn(task, repo) &&
      (await ensureAutoMergeLabel(repo.path).then(
        () => true,
        () => false,
      ));
    const url = await github.createPr({
      cwd: task.checkout?.worktree ?? repo.path,
      base: repo.base_branch,
      head: branch,
      title: task.title,
      body: buildPrBody(task, app.runsForTask(task.id), prPlanFor(app, task)),
      draft: repo.pr_mode === 'draft',
      labels: labelled ? [AUTO_MERGE_LABEL.name] : [],
    });
    app.recordPr(task.id, { type: 'opened', url });
    logPrEvent(app, task.id, { url });
    return { url };
  } catch (err) {
    const error = errorMessage(err);
    // Tell dependents the PR won't appear on its own. A PR that is already open stays open.
    app.recordPr(task.id, { type: 'failed', error });
    logPrEvent(app, task.id, { error });
    return { error };
  }
}
