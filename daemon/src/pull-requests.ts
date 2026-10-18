// Wiring for pull requests: open one when a task finishes, and keep the state of open ones fresh.
import { appendFileSync } from 'node:fs';
import type { Db, Task } from './db.ts';
import { buildPrBody } from './domain/pr.ts';
import { github } from './github.ts';

/** How often the scheduler re-reads the state of open PRs. */
export const PR_REFRESH_MS = 3 * 60_000;

/** Record a PR event on the task's latest run log, where `agentdeck log` and the dashboard show it. */
function logPrEvent(db: Db, taskId: number, event: { url?: string; error?: string }): void {
  const run = db.runsForTask(taskId).at(-1);
  if (!run) return;
  try {
    appendFileSync(run.log_path, JSON.stringify({ type: 'agentdeck_pr', ...event }) + '\n');
  } catch {
    // the log is a convenience; the notification carries the error too
  }
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
    // A task that was retried after its PR was opened already has one; the push above updated it.
    if (task.pr_url) return { url: task.pr_url };
    const url = await github.createPr({
      cwd: task.worktree ?? repo.path,
      base: repo.base_branch,
      head: task.branch,
      title: task.title,
      body: buildPrBody(task, db.runsForTask(task.id)),
      draft: repo.pr_mode === 'draft',
    });
    db.updateTask(task.id, { pr_url: url, pr_state: 'open' });
    logPrEvent(db, task.id, { url });
    return { url };
  } catch (err) {
    const error = (err as Error).message;
    logPrEvent(db, task.id, { error });
    return { error };
  }
}

/** Re-read the state of every open PR of a done task. A failed lookup leaves that task as it was. */
export async function refreshPrStates(db: Db, log: (msg: string) => void = () => {}): Promise<void> {
  for (const task of db.openPrTasks()) {
    try {
      const state = await github.prState(task.pr_url!, task.worktree ?? db.getRepo(task.repo_id)?.path ?? process.cwd());
      if (state !== task.pr_state) {
        db.updateTask(task.id, { pr_state: state });
        log(`task ${task.id}: PR is ${state}`);
      }
    } catch (err) {
      log(`task ${task.id}: could not read PR state: ${(err as Error).message}`);
    }
  }
}
