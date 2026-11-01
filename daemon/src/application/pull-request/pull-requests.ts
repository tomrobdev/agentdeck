// Pull requests: open one when a task finishes, and keep the state of open ones fresh.
import { removeWorktree } from '../../adapters/git.ts';
import { github } from '../../adapters/github.ts';
import type { Db } from '../../db/index.ts';
import {
  type CheckCounts,
  MERGE_METHODS,
  type MergeMethod,
  type PrDetails,
  checksSettled,
  isMergeMethod,
  mergeCheck,
  mergeFindings,
} from '../../domain/pull-request/merge.ts';
import { type AutoMergeCheck, autoMergeCheck, autoMergeOn } from '../../domain/pull-request/auto-merge.ts';
import { isConflicting, isMergeabilityUnknown } from '../../domain/pull-request/conflict.ts';
import { mergeRequestCheck, mergeRequestPolls } from '../../domain/pull-request/merge-request.ts';
import { buildPrBody } from '../../domain/pull-request/pr.ts';
import { hasOpenPr } from '../../domain/task/stage.ts';
import { type Repo, pausedReason } from '../../domain/repo/repo.ts';
import type { Task } from '../../domain/task/task.ts';
import { ActionError, flag, object, requireTask, requireTaskRepo, text } from '../input.ts';
import { prPlanFor } from '../plans.ts';
import { dependentsWaiting, landsAfter } from '../task/dependencies.ts';
import { settle, settlePr } from '../task/settle.ts';
import { notifyLater } from '../notifications.ts';

/** How often the scheduler re-reads the state of open PRs. */
export const PR_REFRESH_MS = 3 * 60_000;
/** How often it re-reads them while a merge request waits on running checks or on GitHub's mergeability. */
export const MERGE_REQUEST_POLL_MS = 30_000;

/** The tasks whose PR this process is merging right now (the lock, as `syncing` is for syncs). */
const merging = new Set<number>();

/** Whether a merge of this task's PR is under way in this process. */
export const isMergeLocked = (id: number): boolean => merging.has(id);

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
  /** Queued tasks that build on this one and so wait for it. */
  unblocks: { id: number; title: string }[];
  /** Whether the daemon will merge it on its own, and why not yet; null when auto-merge is off for the task. */
  auto_merge: AutoMergeCheck | null;
  /** What a merge request would do now: `merge` it as asked, `wait` for the PR to be ready, or `never` (a person must act). */
  request: AutoMergeCheck;
}

/** The last run that ran the tests: 1 passed, 0 failed, null when none did. */
function lastTestsPassed(db: Db, id: number): number | null {
  return db.runsForTask(id).findLast((r) => r.tests_passed !== null)?.tests_passed ?? null;
}

/** The auto-merge check for a task's PR (read `withFiles`), or null when auto-merge is off for the task. */
function autoMergeFor(db: Db, task: Task, repo: Repo, pr: PrDetails, tests_passed: number | null): AutoMergeCheck | null {
  if (!autoMergeOn(task, repo)) return null;
  return autoMergeCheck({
    repo,
    pr_state: task.pr_state,
    pr,
    tests_passed,
    lands_after: landsAfter(db, task.id),
    paused: pausedReason(db.isPaused(), repo),
  });
}

/** A merge refused because of what the PR's state is; `conflicting` when one of the reasons is a conflict with the base branch. */
class MergeRefused extends ActionError {
  conflicting: boolean;
  constructor(message: string, conflicting: boolean) {
    super(message);
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
  // gh reads the PR by its URL, so any directory of the repo will do; the worktree may be gone.
  return { task, repo, url: task.pr_url, cwd: repo.path };
}

/** Read the PR from GitHub and say what merging it would do. */
export async function mergePreview(db: Db, id: number): Promise<MergePreview> {
  const { task, repo, url, cwd } = mergeable(db, id);
  const pr = await github.prDetails(url, cwd, { withFiles: autoMergeOn(task, repo) }).catch((err) => {
    throw new ActionError(`could not read the PR: ${(err as Error).message}`);
  });
  const tests_passed = lastTestsPassed(db, id);
  const lands_after = landsAfter(db, id);
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
    ...mergeCheck({ pr_state: task.pr_state, pr, tests_passed, lands_after }),
    conflicting: isConflicting(pr),
    unblocks: dependentsWaiting(db, id).map((t) => ({ id: t.id, title: t.title })),
    auto_merge: autoMergeFor(db, task, repo, pr, tests_passed),
    request: mergeRequestCheck({ pr_state: task.pr_state, pr, tests_passed, lands_after }),
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
  const found = mergeFindings({ pr_state: task.pr_state, pr, tests_passed: null, lands_after: landsAfter(db, id) });
  const problems = found.filter((f) => f.problem);
  if (problems.length)
    throw new MergeRefused(
      `can't merge #${id}: ${problems.map((f) => f.text).join('; ')}`,
      problems.some((f) => f.kind === 'conflict'),
    );
  return mergeOpenPr(db, { task, repo, url, cwd }, pr, { method, deleteBranch, reason: `${method} merge` });
}

/** What merging a set of PRs came to: the ones merged, and why each other one was left open. */
export interface MergeAllResult {
  merged: ({ id: number } & MergeResult)[];
  /** `conflicting`: the PR conflicts with the base branch, so a sync may let it merge. */
  skipped: { id: number; reason: string; conflicting: boolean }[];
}

/**
 * Merge the open PRs of the given tasks, as a person approving them all: each with its own method (the task's, then the
 * repo's), then the remote branch and the worktree go, as after an auto-merge. A PR that lands after another waits for a
 * round in which that one merged, so the order the ids come in doesn't matter. One that can't merge stays as it was, with
 * the reason mergeTask refused it. The base moves with every merge; GitHub refuses a PR that then conflicts.
 */
export async function mergeAll(db: Db, input: { ids: number[] }): Promise<MergeAllResult> {
  const ids = object(input).ids;
  if (!Array.isArray(ids) || !ids.every((id) => Number.isInteger(id) && id > 0)) throw new ActionError('ids must be a list of task ids');
  const result: MergeAllResult = { merged: [], skipped: [] };
  let pending = [...new Set(ids as number[])];
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
        // The id is on the entry, so mergeTask's "can't merge #12: " goes.
        result.skipped.push({
          id,
          reason: err.message.replace(`can't merge #${id}: `, ''),
          conflicting: err instanceof MergeRefused && err.conflicting,
        });
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
  opts: { method: MergeMethod; deleteBranch: boolean; reason: string },
): Promise<MergeResult> {
  const { id } = task;
  const { method, deleteBranch } = opts;
  merging.add(id);
  try {
    if (pr.draft) await github.markReady(url, cwd);
    await github.merge({
      url,
      cwd,
      method,
      message: { subject: task.title, body: buildPrBody(task, db.runsForTask(id), prPlanFor(db, task)) },
    });
  } catch (err) {
    throw new ActionError(`merge failed: ${(err as Error).message}`);
  } finally {
    merging.delete(id);
  }
  db.recordMerge(id, method, opts.reason, pr.checks);
  // The base just moved: the repo's other open PRs may now conflict. The scheduler re-reads them at once
  // (a setting, so a merge from the CLI reaches the daemon too).
  db.requestPrCheck();
  const unblocked = dependentsWaiting(db, id).map((t) => t.id);

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
  /** Tasks whose PR is ready to merge now (merge requests first, then auto-merges), with what GitHub said about it. */
  mergeable: { id: number; pr: PrDetails }[];
  /** Merge requests waiting on running checks or on mergeability GitHub hasn't worked out: worth reading again soon. */
  polling: number;
}

/**
 * Re-read the state of every open PR of a done task, and whether it still merges cleanly. A blocked or failed task
 * whose PR was merged becomes done; its mergeability is not read. A failed lookup leaves that task as it was. Resolving the conflicts it finds is the caller's call (`resolveConflicting`).
 */
export async function refreshPrStates(db: Db, log: (msg: string) => void = () => {}): Promise<PrRefresh> {
  const found: PrRefresh = { conflicting: [], unknown: 0, mergeable: [], polling: 0 };
  const requested: PrRefresh['mergeable'] = [];
  const dropRequest = (id: number, why: string) => {
    if (db.clearMergeRequest(id)) log(`task ${id}: merge request dropped: ${why}`);
  };
  for (const task of db.openPrTasks()) {
    try {
      const repo = db.getRepo(task.repo_id);
      const cwd = task.worktree ?? repo?.path ?? process.cwd();
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
      if (state !== 'open' || task.status !== 'done') {
        if (task.merge_requested_at) dropRequest(task.id, state !== 'open' ? `the PR is ${state}` : `the task is ${task.status}`);
        continue;
      }
      const pr = await github.prDetails(task.pr_url!, cwd, { withFiles: !!repo && autoMergeOn(task, repo) });
      if (checksSettled(pr.checks)) db.recordPrChecksOpened(task.id, pr.checks);
      const tests = lastTestsPassed(db, task.id);
      if (task.merge_requested_at) {
        // A person asked: the merge request's check stands in for auto-merge's.
        const check = mergeRequestCheck({ pr_state: task.pr_state, pr, tests_passed: tests, lands_after: landsAfter(db, task.id) });
        db.setAutoMergeCheck(task.id, null);
        if (check.verdict === 'never') {
          const why = check.reasons.join('; ');
          dropRequest(task.id, why);
          notifyLater(db, { kind: 'merged', title: `Could not merge #${task.id}`, body: why, task_id: task.id });
          continue;
        }
        db.setMergeRequestCheck(task.id, JSON.stringify(check));
        if (mergeRequestPolls(check, pr)) found.polling++;
        if (isConflicting(pr)) found.conflicting.push(task.id);
        else if (isMergeabilityUnknown(pr)) found.unknown++;
        else if (check.verdict === 'merge') requested.push({ id: task.id, pr });
        continue;
      }
      // Every check is kept on the task for the views, whatever the verdict; none when auto-merge is off.
      const check = repo ? autoMergeFor(db, task, repo, pr, tests) : null;
      db.setAutoMergeCheck(task.id, check && JSON.stringify(check));
      if (isConflicting(pr)) found.conflicting.push(task.id);
      else if (isMergeabilityUnknown(pr)) found.unknown++;
      else if (check?.verdict === 'merge') found.mergeable.push({ id: task.id, pr });
    } catch (err) {
      log(`task ${task.id}: could not read PR state: ${(err as Error).message}`);
    }
  }
  found.mergeable.unshift(...requested);
  return found;
}
