// Merging a done task's PR, as a person asked or on its own, and closing one.
import type { App } from '#application/ports/app.ts';
import { type MergeFailure, type PrDetails, mergeCheck, mergeFailure, mergeFindings } from '#domain/landing/index.ts';
import { MERGE_METHODS, type MergeMethod, isMergeMethod } from '#domain/repos/index.ts';
import { type MergeVerdictView, autoMergeOn, verdictView } from '#domain/landing/index.ts';
import type { CheckCounts } from '#domain/landing/index.ts';
import { carryFailures, countWithSteps, isConflicting, withCheckList } from '#domain/landing/index.ts';
import { mergeRequestCheck, mergesNow } from '#domain/landing/index.ts';
import { buildPrBody, openPrUrl } from '#domain/landing/index.ts';
import { mergeReason } from '#domain/work/index.ts';
import type { TaskId } from '#domain/shared/index.ts';
import type { Task } from '#domain/work/index.ts';
import { errorMessage, present } from '#domain/shared/index.ts';
import { ActionError, flag, object, requireTask, requireTaskRepo, text } from '#application/shared/input.ts';
import { prPlanFor } from '#application/work/plans.ts';
import { dependentsReleased } from '#application/work/dependencies.ts';
import { isMergeLocked, isSyncing, lockMerge, unlockMerge } from '#application/work/checkout-locks.ts';
import { autoMergeFor, mergeInputFor, prCwd } from '#application/landing/pull-request/refresh.ts';
import { movePr } from '#application/landing/moves.ts';

export async function closePullRequest(app: App, task: Task): Promise<void> {
  await app.codeHost.closePr(present(task.pr?.url, `#${task.id}'s pull request`), prCwd(app, task));
  movePr(app, task, { type: 'closed' });
}

export async function closeTaskPr(app: App, id: TaskId): Promise<void> {
  const t = requireTask(app, id);
  if (!openPrUrl(t.pr)) throw new ActionError(`#${id} has no open pull request`);
  try {
    await closePullRequest(app, t);
  } catch (err) {
    throw new ActionError(`could not close the PR: ${errorMessage(err)}`);
  }
}

export interface MergePreview {
  title: string;
  pr_url: string;
  branch: string | null;
  base: string;
  method: MergeMethod;
  draft: boolean;
  commits: number;
  files: number;
  additions: number;
  deletions: number;
  tests_passed: number | null;
  checks: CheckCounts;
  problems: string[];
  warnings: string[];
  conflicting: boolean;
  unblocks: { id: TaskId; title: string }[];
  auto_merge: MergeVerdictView | null;
  request: MergeVerdictView;
  merge_now: boolean;
}

export class MergeFailed extends ActionError {
  failure: MergeFailure;
  constructor(message: string, failure: MergeFailure) {
    super(message);
    this.failure = failure;
  }
}

export function mergeable(app: App, id: TaskId) {
  const task = requireTask(app, id);
  const repo = requireTaskRepo(app, task);
  if (task.status !== 'done') throw new ActionError(`#${id} is ${task.status}; only a done task can be merged`);
  if (!task.pr?.url) throw new ActionError(`#${id} has no pull request`);
  const url = openPrUrl(task.pr);
  if (!url) throw new ActionError(`#${id}'s PR is ${task.pr.state}`);
  if (isSyncing(app, id)) throw new ActionError(`#${id} is syncing with its base branch; try again when that is done`);
  return { task, repo, url, cwd: repo.path };
}

export async function mergePreview(app: App, id: TaskId): Promise<MergePreview> {
  const { task, repo, url, cwd } = mergeable(app, id);
  const read = await app.codeHost.prDetails(url, cwd, { withFiles: autoMergeOn(task, repo) }).catch((err) => {
    throw new ActionError(`could not read the PR: ${errorMessage(err)}`);
  });
  const pr = withCheckList(read, carryFailures(task.pr?.checks.latest ?? null, read.head ?? null, read.check_list ?? []).checks);
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
    tests_passed: tests_passed === null ? null : tests_passed ? 1 : 0,
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
  unblocked: TaskId[];
  cleanup_error?: string;
  elsewhere?: true;
}

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
    const now = await app.codeHost.prDetails(url, cwd).catch(() => null);
    if (now?.state !== 'merged') throw new MergeFailed(`merge failed: ${error}`, mergeFailure(error));
    failed = error;
  } finally {
    unlockMerge(id);
  }
  if (!app.recordMerge(id, method, opts.reason, countWithSteps(task.pr?.checks.latest ?? null, pr))) {
    if (failed) return { method, unblocked: [], elsewhere: true };
    log(`task ${id}: merged its PR (${method}), but the merge was already recorded or the task has moved on`);
  } else if (failed) log(`task ${id}: gh said the merge failed (${failed}), but GitHub has it merged: recorded`);
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
