// Merging a done task's PR, as a person asked or on its own, and closing one.
import { removeWorktree } from '../../adapters/git.ts';
import { github } from '../../adapters/github.ts';
import type { Db } from '../../db/index.ts';
import { stored } from '../../db/mappers.ts';
import {
  MERGE_METHODS,
  type MergeMethod,
  type PrDetails,
  isMergeMethod,
  mergeCheck,
  mergeFindings,
} from '../../domain/pull-request/merge.ts';
import { type AutoMergeCheck, autoMergeOn } from '../../domain/pull-request/auto-merge.ts';
import type { CheckCounts } from '../../domain/pull-request/checks.ts';
import { isConflicting } from '../../domain/pull-request/conflict.ts';
import { mergeRequestCheck, mergesNow } from '../../domain/pull-request/merge-request.ts';
import { buildPrBody } from '../../domain/pull-request/pr.ts';
import { mergeReason } from '../../domain/task/history.ts';
import { hasOpenPr } from '../../domain/task/stage.ts';
import type { Task } from '../../domain/task/task.ts';
import { errorMessage } from '../../domain/text.ts';
import { ActionError, flag, object, requireTask, requireTaskRepo, text } from '../input.ts';
import { prPlanFor } from '../plans.ts';
import { dependentsReleased, landsAfter } from '../task/dependencies.ts';
import { settlePr } from '../task/settle.ts';
import { isSyncing } from '../sync.ts';
import { isMergeLocked, lockMerge, unlockMerge } from './merge-lock.ts';
import { autoMergeFor, lastTestsPassed, prCwd } from './refresh.ts';

export { isMergeLocked };

/** Close a task's PR on GitHub and record it. Throws if `gh` fails. */
export async function closePullRequest(db: Db, task: Task): Promise<void> {
  await github.closePr(task.pr_url!, prCwd(db, task));
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
  /** Queued tasks that build on this one and so wait for it. */
  unblocks: { id: number; title: string }[];
  /** Whether the daemon will merge it on its own, and why not yet; null when auto-merge is off for the task. */
  auto_merge: AutoMergeCheck | null;
  /** What a merge request would do now: `merge` it as asked, `wait` for the PR to be ready, or `never` (a person must act). */
  request: AutoMergeCheck;
  /** Whether the dialog merges now (failing checks or failed tests, on the person's say-so) instead of asking for a merge request. */
  merge_now: boolean;
}

/** A merge refused because of what the PR's state is, with the `reasons`; `conflicting` when one of them is a conflict with the base branch. */
class MergeRefused extends ActionError {
  reasons: string[];
  conflicting: boolean;
  constructor(id: number, reasons: string[], conflicting: boolean) {
    super(`can't merge #${id}: ${reasons.join('; ')}`);
    this.reasons = reasons;
    this.conflicting = conflicting;
  }
}

/** The task, its repo and its open PR, or an ActionError saying why it can't be merged. */
export function mergeable(db: Db, id: number) {
  const task = requireTask(db, id);
  const repo = requireTaskRepo(db, task);
  if (task.status !== 'done') throw new ActionError(`#${id} is ${task.status}; only a done task can be merged`);
  if (!task.pr_url) throw new ActionError(`#${id} has no pull request`);
  if (!hasOpenPr(task)) throw new ActionError(`#${id}'s PR is ${task.pr_state ?? 'not open'}`);
  if (isSyncing(db, id)) throw new ActionError(`#${id} is syncing with its base branch; try again when that is done`);
  // gh reads the PR by its URL, so any directory of the repo will do; the worktree may be gone.
  return { task, repo, url: task.pr_url, cwd: repo.path };
}

/** Read the PR from GitHub and say what merging it would do. */
export async function mergePreview(db: Db, id: number): Promise<MergePreview> {
  const { task, repo, url, cwd } = mergeable(db, id);
  const pr = await github.prDetails(url, cwd, { withFiles: autoMergeOn(task, repo) }).catch((err) => {
    throw new ActionError(`could not read the PR: ${errorMessage(err)}`);
  });
  const tests_passed = lastTestsPassed(db, id);
  const lands_after = landsAfter(db, id);
  const request = mergeRequestCheck({ pr_state: task.pr_state, pr, tests_passed, lands_after, auto_resolve: repo.auto_resolve });
  return {
    title: task.title,
    pr_url: url,
    branch: task.branch,
    base: repo.base_branch,
    method: repo.merge_method,
    draft: pr.draft,
    commits: pr.commits,
    files: pr.files,
    additions: pr.additions,
    deletions: pr.deletions,
    tests_passed: stored({ tests_passed }).tests_passed, // the API keeps 1, 0 or null
    checks: pr.checks,
    ...mergeCheck({ pr_state: task.pr_state, pr, tests_passed, lands_after }),
    conflicting: isConflicting(pr),
    unblocks: dependentsReleased(db, id).map((t) => ({ id: t.id, title: t.title })),
    auto_merge: autoMergeFor(db, task, repo, pr, tests_passed),
    request,
    merge_now: mergesNow(request, { pr, tests_passed }),
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
  const method = given ?? repo.merge_method;
  if (!isMergeMethod(method)) throw new ActionError(`method must be one of ${MERGE_METHODS.join(', ')}`);

  const pr = await github.prDetails(url, cwd).catch((err) => {
    throw new ActionError(`could not read the PR: ${errorMessage(err)}`);
  });
  const found = mergeFindings({ pr_state: task.pr_state, pr, tests_passed: null, lands_after: landsAfter(db, id) });
  const problems = found.filter((f) => f.problem);
  if (problems.length)
    throw new MergeRefused(
      id,
      problems.map((f) => f.text),
      problems.some((f) => f.kind === 'conflict'),
    );
  return mergeOpenPr(db, { task, repo, url, cwd }, pr, { method, deleteBranch, reason: mergeReason('person', method) });
}

/** What merging a set of PRs came to: the ones merged, and why each other one was left open. */
export interface MergeAllResult {
  merged: ({ id: number } & MergeResult)[];
  /** `conflicting`: the PR conflicts with the base branch, so a sync may let it merge. */
  skipped: { id: number; reason: string; conflicting: boolean }[];
}

/**
 * Merge the open PRs of the given tasks, as a person approving them all: each with the repo's method, then the remote branch and the worktree go, as after an auto-merge. A PR that lands after another waits for a
 * round in which that one merged, so the order the ids come in doesn't matter. One that can't merge stays as it was, with
 * the reason mergeTask refused it. The base moves with every merge; GitHub refuses a PR that then conflicts.
 */
export async function mergeAll(db: Db, input: { ids: number[] }): Promise<MergeAllResult> {
  const result: MergeAllResult = { merged: [], skipped: [] };
  let pending = [...new Set(input.ids)];
  // A round with nothing merged frees no one, so the next round tries every PR left, to say why each stays open.
  let last = false;
  while (pending.length) {
    const now = last ? pending : pending.filter((id) => !landsAfter(db, id).length);
    pending = pending.filter((id) => !now.includes(id));
    let merged = false;
    for (const id of now) {
      try {
        result.merged.push({ id, ...(await mergeTask(db, id, { delete_branch: true })) });
        merged = true;
      } catch (err) {
        if (!(err instanceof ActionError)) throw err;
        // The id is on the entry, so a refusal gives its reasons without mergeTask's "can't merge #12: ".
        const refused = err instanceof MergeRefused ? err : null;
        result.skipped.push({ id, reason: refused ? refused.reasons.join('; ') : err.message, conflicting: refused?.conflicting ?? false });
      }
    }
    last = !merged;
  }
  return result;
}

/**
 * Merge a PR that has been checked: mark a draft ready, merge, record it with `reason`, and optionally clean up.
 * Throws ActionError if gh fails; a cleanup failure after the merge is returned, not thrown.
 */
export async function mergeOpenPr(
  db: Db,
  { task, repo, url, cwd }: ReturnType<typeof mergeable>,
  pr: PrDetails,
  opts: { method: MergeMethod; deleteBranch: boolean; reason: string; log?: (msg: string) => void },
): Promise<MergeResult> {
  const { id } = task;
  const { method, deleteBranch, log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`) } = opts;
  if (!lockMerge(id)) throw new ActionError(`#${id} is already being merged`);
  if (isSyncing(db, id)) {
    unlockMerge(id);
    throw new ActionError(`#${id} is syncing with its base branch; try again when that is done`);
  }
  try {
    if (pr.draft) await github.markReady(url, cwd);
    await github.merge({
      url,
      cwd,
      method,
      message: { subject: task.title, body: buildPrBody(task, db.runsForTask(id), prPlanFor(db, task)) },
    });
  } catch (err) {
    throw new ActionError(`merge failed: ${errorMessage(err)}`);
  } finally {
    unlockMerge(id);
  }
  // False when a refresh in another process already recorded the PR as merged: say so, so the merge leaves a trace.
  if (!db.recordMerge(id, method, opts.reason, pr.checks))
    log(`task ${id}: merged its PR (${method}), but the merge was already recorded or the task has moved on`);
  // The base just moved: the repo's other open PRs may now conflict. The scheduler re-reads them at once
  // (a setting, so a merge from the CLI reaches the daemon too).
  db.requestPrCheck();
  const unblocked = dependentsReleased(db, id).map((t) => t.id);

  const result: MergeResult = { method, unblocked };
  if (deleteBranch) {
    const errors: string[] = [];
    if (task.branch)
      await github.deleteRemoteBranch(repo.path, task.branch).catch((err) => errors.push(`remote branch: ${errorMessage(err)}`));
    if (task.worktree)
      await removeWorktree(repo, task.worktree).then(
        () => db.setCheckout(id, { worktree: null }),
        (err) => errors.push(`worktree: ${errorMessage(err)}`),
      );
    if (errors.length) result.cleanup_error = errors.join('; ');
  }
  return result;
}
