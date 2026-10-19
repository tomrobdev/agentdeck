// Pull requests: open one when a task finishes, and keep the state of open ones fresh.
import { removeWorktree } from '../adapters/git.ts';
import { github } from '../adapters/github.ts';
import { appendEvent } from '../adapters/run-log.ts';
import type { Db } from '../db/index.ts';
import { type CheckCounts, MERGE_METHODS, type MergeMethod, isMergeMethod, mergeCheck } from '../domain/pull-request/merge.ts';
import { buildPrBody } from '../domain/pull-request/pr.ts';
import type { Task } from '../domain/task/task.ts';
import { warnStuckDependents } from './dependencies.ts';
import { ActionError } from './errors.ts';

/** How often the scheduler re-reads the state of open PRs. */
export const PR_REFRESH_MS = 3 * 60_000;

/** Record a PR event on the task's latest run log, where `agentdeck log` and the dashboard show it. */
function logPrEvent(db: Db, taskId: number, event: { url?: string; error?: string }): void {
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
    if (task.pr_url && task.pr_state === 'open') return { url: task.pr_url };
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
    // Tell dependents the PR won't appear on its own. A PR that is already open stays open.
    if (!(task.pr_url && task.pr_state === 'open')) db.updateTask(task.id, { pr_state: 'failed' });
    logPrEvent(db, task.id, { error });
    return { error };
  }
}

/** What a person sees before merging a task's PR: the PR, what the merge does and what it releases. */
export interface MergePreview {
  title: string;
  pr_url: string;
  branch: string | null;
  base: string;
  /** The method the repo defaults to; the dialog starts here. */
  method: MergeMethod;
  draft: boolean;
  commits: number;
  files: number;
  additions: number;
  deletions: number;
  /** The task's last run: 1 passed, 0 failed, null not run. */
  tests_passed: number | null;
  checks: CheckCounts;
  problems: string[];
  warnings: string[];
  /** Queued tasks waiting on this one with `--after`. */
  unblocks: { id: number; title: string }[];
}

/** The task, its repo and its open PR, or an ActionError saying why it can't be merged. */
function mergeable(db: Db, id: number) {
  const task = db.getTask(id);
  if (!task) throw new ActionError('no such task');
  const repo = db.getRepo(task.repo_id);
  if (!repo) throw new ActionError('the task has no repo');
  if (task.status !== 'done') throw new ActionError(`#${id} is ${task.status}; only a done task can be merged`);
  if (!task.pr_url) throw new ActionError(`#${id} has no pull request`);
  if (task.pr_state !== 'open') throw new ActionError(`#${id}'s PR is ${task.pr_state ?? 'not open'}`);
  // gh reads the PR by its URL, so any directory of the repo will do; the worktree may be gone.
  return { task, repo, url: task.pr_url, cwd: repo.path };
}

/** Read the PR from GitHub and say what merging it would do. */
export async function mergePreview(db: Db, id: number): Promise<MergePreview> {
  const { task, repo, url, cwd } = mergeable(db, id);
  const pr = await github.prDetails(url, cwd).catch((err) => {
    throw new ActionError(`could not read the PR: ${(err as Error).message}`);
  });
  const tests_passed = db.runsForTask(id).at(-1)?.tests_passed ?? null;
  return {
    title: task.title,
    pr_url: url,
    branch: task.branch,
    base: repo.base_branch,
    method: task.merge_method ?? repo.merge_method,
    draft: pr.draft,
    commits: pr.commits,
    files: pr.files,
    additions: pr.additions,
    deletions: pr.deletions,
    tests_passed,
    checks: pr.checks,
    ...mergeCheck({ pr_state: task.pr_state, pr, tests_passed }),
    unblocks: db.dependentsOf(id).map((t) => ({ id: t.id, title: t.title })),
  };
}

export interface MergeResult {
  method: MergeMethod;
  /** Tasks that were waiting on this PR and are free to start. */
  unblocked: number[];
  /** Set when the merge went through but removing the branch or worktree did not. */
  cleanup_error?: string;
}

/**
 * Merge a done task's open PR through gh, as the person asked: mark a draft ready, merge, record it, and
 * optionally delete the remote branch and remove the worktree (the local branch stays, so the diff can still be read).
 * The tasks waiting on it start on the scheduler's next tick. Throws ActionError if the PR can't be merged;
 * a cleanup failure after the merge is returned, not thrown.
 */
export async function mergeTask(db: Db, id: number, opts: { method?: string; delete_branch?: boolean } = {}): Promise<MergeResult> {
  const { task, repo, url, cwd } = mergeable(db, id);
  const method = opts.method ?? task.merge_method ?? repo.merge_method;
  if (!isMergeMethod(method)) throw new ActionError(`method must be one of ${MERGE_METHODS.join(', ')}`);

  const pr = await github.prDetails(url, cwd).catch((err) => {
    throw new ActionError(`could not read the PR: ${(err as Error).message}`);
  });
  const { problems } = mergeCheck({ pr_state: task.pr_state, pr, tests_passed: null });
  if (problems.length) throw new ActionError(`can't merge #${id}: ${problems.join('; ')}`);

  try {
    if (pr.draft) await github.markReady(url, cwd);
    await github.merge({ url, cwd, method, message: { subject: task.title, body: buildPrBody(task, db.runsForTask(id)) } });
  } catch (err) {
    throw new ActionError(`merge failed: ${(err as Error).message}`);
  }
  db.recordMerge(id, method, `${method} merge`);
  const unblocked = db.dependentsOf(id).map((t) => t.id);

  const result: MergeResult = { method, unblocked };
  if (opts.delete_branch) {
    const errors: string[] = [];
    if (task.branch)
      await github.deleteRemoteBranch(repo.path, task.branch).catch((err) => errors.push(`remote branch: ${(err as Error).message}`));
    if (task.worktree)
      await removeWorktree(repo, task.worktree).then(
        () => db.updateTask(id, { worktree: null }),
        (err) => errors.push(`worktree: ${(err as Error).message}`),
      );
    if (errors.length) result.cleanup_error = errors.join('; ');
  }
  return result;
}

/** Re-read the state of every open PR of a done task. A failed lookup leaves that task as it was. */
export async function refreshPrStates(db: Db, log: (msg: string) => void = () => {}): Promise<void> {
  for (const task of db.openPrTasks()) {
    try {
      const state = await github.prState(task.pr_url!, task.worktree ?? db.getRepo(task.repo_id)?.path ?? process.cwd());
      if (state !== task.pr_state) {
        db.updateTask(task.id, { pr_state: state });
        log(`task ${task.id}: PR is ${state}`);
        if (state === 'closed') warnStuckDependents(db, task.id);
      }
    } catch (err) {
      log(`task ${task.id}: could not read PR state: ${(err as Error).message}`);
    }
  }
}
