// Merging a done task's PR, as a person asked or on its own, and closing one.
import type { App } from '../ports/app.ts';
import { type MergeFailure, type PrDetails, mergeCheck, mergeFailure, mergeFindings } from '../../domain/landing/index.ts';
import { MERGE_METHODS, type MergeMethod, isMergeMethod } from '../../domain/repos/index.ts';
import { type MergeVerdictView, autoMergeOn, verdictView } from '../../domain/landing/index.ts';
import type { CheckCounts } from '../../domain/landing/index.ts';
import { isConflicting } from '../../domain/landing/index.ts';
import { mergeRequestCheck, mergesNow } from '../../domain/landing/index.ts';
import { buildPrBody, openPrUrl } from '../../domain/landing/index.ts';
import { mergeReason } from '../../domain/work/index.ts';
import type { TaskId } from '../../domain/shared/index.ts';
import type { Task } from '../../domain/work/index.ts';
import { errorMessage } from '../../domain/shared/index.ts';
import { ActionError, flag, object, requireTask, requireTaskRepo, text } from '../shared/input.ts';
import { prPlanFor } from '../work/plans.ts';
import { dependentsReleased } from '../work/dependencies.ts';
import { isMergeLocked, isSyncing, lockMerge, unlockMerge } from '../work/checkout-locks.ts';
import { autoMergeFor, mergeInputFor, prCwd } from './refresh.ts';

/** Close a task's PR on GitHub and record it. Throws if `gh` fails. */
export async function closePullRequest(app: App, task: Task): Promise<void> {
  await app.codeHost.closePr(task.pr!.url!, prCwd(app, task));
  app.recordPr(task.id, { type: 'closed' });
}

/** Close a task's open PR without merging it. Tasks waiting on it become stuck. */
export async function closeTaskPr(app: App, id: TaskId): Promise<void> {
  const t = requireTask(app, id);
  if (!openPrUrl(t.pr)) throw new ActionError(`#${id} has no open pull request`);
  try {
    await closePullRequest(app, t);
  } catch (err) {
    throw new ActionError(`could not close the PR: ${errorMessage(err)}`);
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
  /** One of the problems is a conflict with the base branch, which a resolve run can fix. */
  conflicting: boolean;
  /** Queued tasks that build on this one and so wait for it. */
  unblocks: { id: TaskId; title: string }[];
  /** Whether the daemon will merge it on its own, and why not yet; null when auto-merge is off for the task. */
  auto_merge: MergeVerdictView | null;
  /** What a merge request would do now: `merge` it as asked, `wait` for the PR to be ready, or `never` (a person must act). */
  request: MergeVerdictView;
  /** Whether the dialog merges now (failing checks or failed tests, on the person's say-so) instead of asking for a merge request. */
  merge_now: boolean;
}

/** A merge that did not go through, with what it means for trying again (`mergeFailure`). */
export class MergeFailed extends ActionError {
  failure: MergeFailure;
  constructor(message: string, failure: MergeFailure) {
    super(message);
    this.failure = failure;
  }
}

/** The task, its repo and its open PR, or an ActionError saying why it can't be merged. */
export function mergeable(app: App, id: TaskId) {
  const task = requireTask(app, id);
  const repo = requireTaskRepo(app, task);
  if (task.status !== 'done') throw new ActionError(`#${id} is ${task.status}; only a done task can be merged`);
  if (!task.pr?.url) throw new ActionError(`#${id} has no pull request`);
  const url = openPrUrl(task.pr);
  if (!url) throw new ActionError(`#${id}'s PR is ${task.pr.state}`);
  if (isSyncing(app, id)) throw new ActionError(`#${id} is syncing with its base branch; try again when that is done`);
  // gh reads the PR by its URL, so any directory of the repo will do; the worktree may be gone.
  return { task, repo, url, cwd: repo.path };
}

/** Read the PR from GitHub and say what merging it would do. */
export async function mergePreview(app: App, id: TaskId): Promise<MergePreview> {
  const { task, repo, url, cwd } = mergeable(app, id);
  const pr = await app.codeHost.prDetails(url, cwd, { withFiles: autoMergeOn(task, repo) }).catch((err) => {
    throw new ActionError(`could not read the PR: ${errorMessage(err)}`);
  });
  const input = mergeInputFor(app, task, repo, pr);
  const { tests_passed } = input;
  const request = mergeRequestCheck(input);
  const auto_merge = await autoMergeFor(app, task, repo, input);
  return {
    title: task.title,
    pr_url: url,
    branch: task.checkout?.branch ?? null,
    base: repo.base_branch,
    method: repo.merge_method,
    draft: pr.draft,
    commits: pr.commits,
    files: pr.files,
    additions: pr.additions,
    deletions: pr.deletions,
    tests_passed: tests_passed === null ? null : tests_passed ? 1 : 0, // the API keeps 1, 0 or null
    checks: pr.checks,
    ...mergeCheck(input),
    conflicting: isConflicting(pr),
    unblocks: dependentsReleased(app, id).map((t) => ({ id: t.id, title: t.title })),
    auto_merge: auto_merge && verdictView(auto_merge),
    request: verdictView(request),
    merge_now: mergesNow(request, input),
  };
}

export interface MergeResult {
  method: MergeMethod;
  /** Tasks that were waiting on this PR and are free to start. */
  unblocked: TaskId[];
  /** Set when the merge went through but removing the branch or worktree did not. */
  cleanup_error?: string;
  /** Set when gh failed because the PR was merged meanwhile by someone else, who recorded it. */
  elsewhere?: true;
}

/**
 * Merge a done task's open PR through gh, as the person asked: mark a draft ready, merge, record it, and
 * optionally delete the remote branch and remove the worktree (the local branch stays, so the diff can still be read).
 * The tasks waiting on it start on the scheduler's next tick. Throws ActionError if the PR can't be merged;
 * a cleanup failure after the merge is returned, not thrown.
 */
export async function mergeTask(app: App, id: TaskId, opts: { method?: string; delete_branch?: boolean } = {}): Promise<MergeResult> {
  const body = object(opts);
  const given = text(body, 'method', { empty: true, raw: true });
  const deleteBranch = flag(body, 'delete_branch') === true;
  const { task, repo, url, cwd } = mergeable(app, id);
  const method = given ?? repo.merge_method;
  if (!isMergeMethod(method)) throw new ActionError(`method must be one of ${MERGE_METHODS.join(', ')}`);

  const pr = await app.codeHost.prDetails(url, cwd).catch((err) => {
    throw new ActionError(`could not read the PR: ${errorMessage(err)}`);
  });
  const found = mergeFindings(mergeInputFor(app, task, repo, pr));
  const problems = found.filter((f) => f.problem);
  if (problems.length) throw new ActionError(`can't merge #${id}: ${problems.map((f) => f.text).join('; ')}`);
  return mergeOpenPr(app, { task, repo, url, cwd }, pr, { method, deleteBranch, reason: mergeReason('person', method) });
}

/**
 * Merge a PR that has been checked, as `pr` read it: mark a draft ready, merge its head `pr.head` and nothing else, record
 * it with `reason`, and optionally clean up. A merge gh reports failed while GitHub reads the PR merged afterwards (a
 * timeout after the merge) is recorded the same way; `elsewhere` when the merge was already recorded (another process
 * merged it), and then nothing is cleaned up. Throws MergeFailed if the merge did not go through; a cleanup failure after
 * the merge is returned, not thrown.
 */
export async function mergeOpenPr(
  app: App,
  { task, repo, url, cwd }: ReturnType<typeof mergeable>,
  pr: PrDetails,
  opts: { method: MergeMethod; deleteBranch: boolean; reason: string; log?: (msg: string) => void },
): Promise<MergeResult> {
  const { id } = task;
  const { method, deleteBranch, log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`) } = opts;
  const head = pr.head;
  if (!head) throw new MergeFailed(`GitHub did not say which commit #${id}'s PR is at, so the merge can't be pinned to it`, 'lasting');
  if (!lockMerge(id)) throw new MergeFailed(`#${id} is already being merged`, 'transient');
  if (isSyncing(app, id)) {
    unlockMerge(id);
    throw new MergeFailed(`#${id} is syncing with its base branch; try again when that is done`, 'transient');
  }
  let failed: string | null = null;
  try {
    if (pr.draft) await app.codeHost.markReady(url, cwd);
    await app.codeHost.merge({
      url,
      cwd,
      method,
      head,
      message: { subject: task.title, body: buildPrBody(task, app.runsForTask(id), prPlanFor(app, task)) },
    });
  } catch (err) {
    const error = errorMessage(err);
    // gh may fail after GitHub merged (a timeout on the answer): what GitHub says now decides.
    const now = await app.codeHost.prDetails(url, cwd).catch(() => null);
    if (now?.state !== 'merged') throw new MergeFailed(`merge failed: ${error}`, mergeFailure(error));
    failed = error;
  } finally {
    unlockMerge(id);
  }
  // False when a refresh in another process already recorded the PR as merged: say so, so the merge leaves a trace.
  if (!app.recordMerge(id, method, opts.reason, pr.checks)) {
    // gh failed and someone else recorded the merge: it was theirs, not this one.
    if (failed) return { method, unblocked: [], elsewhere: true };
    log(`task ${id}: merged its PR (${method}), but the merge was already recorded or the task has moved on`);
  } else if (failed) log(`task ${id}: gh said the merge failed (${failed}), but GitHub has it merged: recorded`);
  // The base just moved: the repo's other open PRs may now conflict. The scheduler re-reads them at once
  // (a setting, so a merge from the CLI reaches the daemon too).
  app.requestPrCheck();
  const unblocked = dependentsReleased(app, id).map((t) => t.id);

  const result: MergeResult = { method, unblocked };
  if (deleteBranch) {
    const errors: string[] = [];
    const { branch, worktree } = task.checkout ?? { branch: null, worktree: null };
    if (branch) await app.codeHost.deleteRemoteBranch(repo.path, branch).catch((err) => errors.push(`remote branch: ${errorMessage(err)}`));
    if (worktree)
      await app.workspace.removeCheckout(repo, { worktree }).then(
        () => app.setCheckout(id, { worktree: null }),
        (err) => errors.push(`worktree: ${errorMessage(err)}`),
      );
    if (errors.length) result.cleanup_error = errors.join('; ');
  }
  return result;
}
