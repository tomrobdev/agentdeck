// Opening a task's pull request when it finishes done.
import { github } from '../../adapters/github.ts';
import { appendEvent } from '../../adapters/run-log.ts';
import type { Db } from '../../db/index.ts';
import { buildPrBody } from '../../domain/pull-request/pr.ts';
import { hasOpenPr } from '../../domain/task/stage.ts';
import type { Task } from '../../domain/task/task.ts';
import { prPlanFor } from '../plans.ts';

/** Record a PR event on the task's latest run log, where `agentdeck log` and the dashboard show it. */
export function logPrEvent(db: Db, taskId: number, event: { url?: string; error?: string }): void {
  const run = db.runsForTask(taskId).at(-1);
  if (run) appendEvent(run.log_path, { type: 'agentdeck_pr', ...event });
}

/**
 * For a task that has just finished done: push its branch and open a PR if its repo's pr_mode asks for one.
 * Never throws and never changes the task's status: a failure is logged as an `agentdeck_pr` event and returned.
 */
export async function openPullRequest(db: Db, task: Task): Promise<{ url?: string; error?: string }> {
  const repo = db.getRepo(task.repo_id);
  if (!repo || repo.pr_mode === 'off' || !task.branch) return {};
  try {
    await github.push(repo.path, task.branch);
    // A task retried while its PR is still open keeps that PR; the push above updated it.
    // Once that PR is merged or closed, the new commits need a new PR.
    if (task.pr_url && hasOpenPr(task)) return { url: task.pr_url };
    const url = await github.createPr({
      cwd: task.worktree ?? repo.path,
      base: repo.base_branch,
      head: task.branch,
      title: task.title,
      body: buildPrBody(task, db.runsForTask(task.id), await prPlanFor(db, task).catch(() => null)),
      draft: repo.pr_mode === 'draft',
    });
    db.recordPr(task.id, { type: 'opened', url });
    logPrEvent(db, task.id, { url });
    return { url };
  } catch (err) {
    const error = (err as Error).message;
    // Tell dependents the PR won't appear on its own. A PR that is already open stays open.
    db.recordPr(task.id, { type: 'failed', error });
    logPrEvent(db, task.id, { error });
    return { error };
  }
}
