// Pull requests: open one when a task finishes, and keep the state of open ones fresh.
import { removeWorktree } from '../adapters/git.ts';
import { github } from '../adapters/github.ts';
import type { Db } from '../db/index.ts';
import { type CheckCounts, MERGE_METHODS, type MergeMethod, isMergeMethod, mergeCheck } from '../domain/pull-request/merge.ts';
import { isConflicting, isMergeabilityUnknown } from '../domain/pull-request/conflict.ts';
import { buildPrBody } from '../domain/pull-request/pr.ts';
import { hasOpenPr } from '../domain/task/stage.ts';
import type { Task } from '../domain/task/task.ts';
import { ActionError } from './errors.ts';
import { flag, object, text } from './input.ts';
import { requireTask, requireTaskRepo } from './lookups.ts';
import { prPlanFor } from './plans.ts';
import { settle, settlePr } from './settle.ts';

/** How often the scheduler re-reads the state of open PRs. */
export const PR_REFRESH_MS = 3 * 60_000;

/** Close a task's PR on GitHub and record it. Throws if `gh` fails. */
export async function closePullRequest(db: Db, task: Task): Promise<void> {
  await github.closePr(task.pr_url!, task.worktree ?? db.getRepo(task.repo_id)?.path ?? process.cwd());
  settlePr(db, task.id, { type: 'closed' });
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
  /** One of the problems is a conflict with the base branch, which a resolve run can fix. */
  conflicting: boolean;
  /** Queued tasks waiting on this one with `--after`. */
  unblocks: { id: number; title: string }[];
}

/** The task, its repo and its open PR, or an ActionError saying why it can't be merged. */
function mergeable(db: Db, id: number) {
  const task = requireTask(db, id);
  const repo = requireTaskRepo(db, task);
  if (task.status !== 'done') throw new ActionError(`#${id} is ${task.status}; only a done task can be merged`);
  if (!task.pr_url) throw new ActionError(`#${id} has no pull request`);
  if (!hasOpenPr(task)) throw new ActionError(`#${id}'s PR is ${task.pr_state ?? 'not open'}`);
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
    conflicting: isConflicting(pr),
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
  const body = object(opts);
  const given = text(body, 'method', { empty: true, raw: true });
  const deleteBranch = flag(body, 'delete_branch') === true;
  const { task, repo, url, cwd } = mergeable(db, id);
  const method = given ?? task.merge_method ?? repo.merge_method;
  if (!isMergeMethod(method)) throw new ActionError(`method must be one of ${MERGE_METHODS.join(', ')}`);

  const pr = await github.prDetails(url, cwd).catch((err) => {
    throw new ActionError(`could not read the PR: ${(err as Error).message}`);
  });
  const { problems } = mergeCheck({ pr_state: task.pr_state, pr, tests_passed: null });
  if (problems.length) throw new ActionError(`can't merge #${id}: ${problems.join('; ')}`);

  try {
    if (pr.draft) await github.markReady(url, cwd);
    await github.merge({
      url,
      cwd,
      method,
      message: { subject: task.title, body: buildPrBody(task, db.runsForTask(id), await prPlanFor(db, task).catch(() => null)) },
    });
  } catch (err) {
    throw new ActionError(`merge failed: ${(err as Error).message}`);
  }
  db.recordMerge(id, method, `${method} merge`);
  // The base just moved: the repo's other open PRs may now conflict. The scheduler re-reads them at once
  // (a setting, so a merge from the CLI reaches the daemon too).
  db.requestPrCheck();
  const unblocked = db.dependentsOf(id).map((t) => t.id);

  const result: MergeResult = { method, unblocked };
  if (deleteBranch) {
    const errors: string[] = [];
    if (task.branch)
      await github.deleteRemoteBranch(repo.path, task.branch).catch((err) => errors.push(`remote branch: ${(err as Error).message}`));
    if (task.worktree)
      await removeWorktree(repo, task.worktree).then(
        () => db.setCheckout(id, { worktree: null }),
        (err) => errors.push(`worktree: ${(err as Error).message}`),
      );
    if (errors.length) result.cleanup_error = errors.join('; ');
  }
  return result;
}

/** The setting that asks the scheduler to re-read the open PRs now (a person's merge changed the base). */

/** What a refresh found out about the open PRs beyond their state. */
export interface PrRefresh {
  /** Tasks whose open PR GitHub says conflicts with the base. */
  conflicting: number[];
  /** Open PRs whose mergeability GitHub has not worked out yet (it does so lazily, after the base moves). */
  unknown: number;
}

/**
 * Re-read the state of every open PR of a done task, and whether it still merges cleanly. A blocked or failed task
 * whose PR was merged becomes done; its mergeability is not read. A failed lookup leaves that task as it was. Resolving the conflicts it finds is the caller's call (`resolveConflicting`).
 */
export async function refreshPrStates(db: Db, log: (msg: string) => void = () => {}): Promise<PrRefresh> {
  const found: PrRefresh = { conflicting: [], unknown: 0 };
  for (const task of db.openPrTasks()) {
    try {
      const cwd = task.worktree ?? db.getRepo(task.repo_id)?.path ?? process.cwd();
      const state = await github.prState(task.pr_url!, cwd);
      if (state !== task.pr_state) {
        // Guarded on the PR still being open: a merge recorded while GitHub was being asked stays.
        const applied = state === 'closed' ? settlePr(db, task.id, { type: 'closed' }) : db.recordPr(task.id, { type: 'seen', state });
        if (applied) log(`task ${task.id}: PR is ${state}`);
        if (
          applied &&
          state === 'merged' &&
          task.status !== 'done' &&
          (await settle(db, task.id, { type: 'pr_merged' }, { reason: 'PR merged on GitHub' }))
        )
          log(`task ${task.id}: PR merged, task is done`);
      }
      if (state !== 'open' || task.status !== 'done') continue;
      const pr = await github.prDetails(task.pr_url!, cwd);
      if (isConflicting(pr)) found.conflicting.push(task.id);
      else if (isMergeabilityUnknown(pr)) found.unknown++;
    } catch (err) {
      log(`task ${task.id}: could not read PR state: ${(err as Error).message}`);
    }
  }
  return found;
}
