// The PR refresh: keep the state of open PRs fresh, and say which ones conflict or are ready to merge.
import type { App } from '../../ports/app.ts';
import type { TaskId } from '../../../domain/shared/index.ts';
import type { AutoMergeFacts, MergeInput, PrCheck, PrDetails, PrPlace, ReviewFacts } from '../../../domain/landing/index.ts';
import { type AutoMergeCheck, autoMergeCheck, autoMergeOn, refreshVerdict } from '../../../domain/landing/index.ts';
import { carryFailures, checksSettled, countOfKept, nextChecks } from '../../../domain/landing/index.ts';
import { readFailure } from './check-failures.ts';
import { checksFailedNotification, mergeFailedNotification } from '../../../domain/operations/index.ts';
import { type Repo, pausedReason } from '../../../domain/repos/index.ts';
import type { Task } from '../../../domain/work/index.ts';
import { errorMessage } from '../../../domain/shared/index.ts';
import { landsAfter } from '../../work/dependencies.ts';
import { measureBranch } from '../../work/files.ts';
import { settle } from '../settle.ts';
import { notifyLater } from '../../operations/notifications.ts';

/** How often the scheduler re-reads the state of open PRs. */
export const PR_REFRESH_MS = 3 * 60_000;
/** How often it re-reads them while a merge request waits on running checks or on GitHub's mergeability. */
export const MERGE_REQUEST_POLL_MS = 30_000;

/** Where `gh` runs for a task's PR. It reads the PR by its URL, so the repo's path will do; the worktree may be gone. */
export function prCwd(app: App, task: Task): string {
  return app.getRepo(task.repo_id)?.path ?? process.cwd();
}

/** Whether the last run that ran the tests passed them; null when none did. */
export function lastTestsPassed(app: App, id: TaskId): boolean | null {
  return app.runsForTask(id).findLast((r) => r.tests_passed !== null)?.tests_passed ?? null;
}

/**
 * What every merge check of a task's PR reads, with `pr` as GitHub said it: the task's PR state, its last tested run, the
 * tasks it lands after, and whether its repo syncs conflicts on its own. With no `repo` (it was removed), auto_resolve
 * counts as on.
 */
export function mergeInputFor(app: App, task: Task, repo: Repo | undefined, pr: PrDetails): MergeInput {
  return {
    pr_state: task.pr?.state ?? null,
    pr,
    tests_passed: lastTestsPassed(app, task.id),
    lands_after: landsAfter(app, task.id),
    auto_resolve: repo ? repo.auto_resolve : true,
  };
}

/**
 * What auto-merge's check reads beside the merge input, or null when auto-merge is off for the task. The size is counted
 * from git (`git diff --numstat` against the base in the repo's checkout) when the local branch is at the PR's head, since
 * GitHub's file list stops at 100; from GitHub's numbers otherwise (read `withFiles`).
 */
async function autoMergeFacts(app: App, task: Task, repo: Repo, pr: PrDetails): Promise<AutoMergeFacts | null> {
  if (!autoMergeOn(task, repo)) return null;
  const branch = task.checkout?.branch;
  const [measured, review] = await Promise.all([
    branch && pr.head ? measureBranch(app, repo, branch, pr.head) : null,
    repo.auto_review ? reviewFacts(app, task, repo, pr) : null,
  ]);
  return { repo, paused: pausedReason(app.isPaused(), repo), measured, review };
}

/**
 * What the review gate reads about a task's PR: the patch-id of its changes at the PR's head, as the review run and a
 * submitted review store it, with the task's reviews and runs. The patch-id is null when git can't work it out there.
 */
async function reviewFacts(app: App, task: Task, repo: Repo, pr: PrDetails): Promise<ReviewFacts> {
  const diff_hash = pr.head ? await app.workspace.diffHash(repo.path, repo.base_branch, pr.head).catch(() => null) : null;
  return { diff_hash, reviews: app.reviewsForTask(task.id), runs: app.runsForTask(task.id) };
}

/** The auto-merge check for a task's PR, from its merge input (`mergeInputFor`), or null when auto-merge is off for the task. */
export async function autoMergeFor(app: App, task: Task, repo: Repo, input: MergeInput): Promise<AutoMergeCheck | null> {
  const facts = await autoMergeFacts(app, task, repo, input.pr);
  return facts && autoMergeCheck({ ...input, ...facts });
}

/**
 * Keep a done task's open PR's checks on the task, and tell a person when they newly fail (`nextChecks` says when).
 * A failing GitHub Actions check brings why it failed, read once for each head (`carryFailures`). Nothing is told when
 * the write was refused: the PR merged or closed meanwhile. Returns the checks kept, with what was read.
 */
async function keepChecks(app: App, task: Task, pr: PrDetails): Promise<PrCheck[]> {
  const previous = task.pr?.checks.latest ?? null;
  const head = pr.head ?? null;
  const { checks, unread } = carryFailures(previous, head, pr.check_list ?? []);
  const cwd = prCwd(app, task);
  const read = await Promise.all(checks.map((c) => (unread.includes(c) ? readFailure(app, cwd, c) : c)));
  const { stored, notify } = nextChecks(previous, { head, checks: read, read_at: new Date().toISOString() });
  if (app.setPrChecks(task.id, stored) && notify) notifyLater(app, checksFailedNotification(task, stored.checks));
  return stored.checks;
}

/** A PR the refresh found ready to merge, with what GitHub said about it, and why: a person's merge request, or auto-merge. */
export interface ReadyPr {
  id: TaskId;
  pr: PrDetails;
  requested: boolean;
}

/** What a refresh found out about the open PRs beyond their state. */
export interface PrRefresh {
  /** Tasks whose open PR GitHub says conflicts with the base. */
  conflicting: TaskId[];
  /** Open PRs whose mergeability GitHub has not worked out yet (it does so lazily, after the base moves). */
  unknown: number;
  /** Tasks whose PR is ready to merge now (merge requests first, then auto-merges). */
  mergeable: ReadyPr[];
  /** Merge requests waiting on running checks or on mergeability GitHub hasn't worked out: worth reading again soon. */
  polling: number;
}

/** What a refresh found out about one open PR of a done task. */
interface PrFound {
  pr: PrDetails;
  place: PrPlace;
  /** A person asked for the merge, so it goes before the auto-merges. */
  requested: boolean;
  /** A merge request worth reading again soon. */
  polling: boolean;
}

/** Drop a task's merge request; false when there was none left to drop (a person withdrew it meanwhile). */
function dropRequest(app: App, id: TaskId, why: string, log: (msg: string) => void): boolean {
  if (!app.clearMergeRequest(id)) return false;
  log(`task ${id}: merge request dropped: ${why}`);
  return true;
}

/**
 * Re-read one task's PR and record what changed. Null when the PR is no longer open, the task is not done, or its merge
 * request was dropped. Throws when GitHub can't be read.
 */
async function refreshOne(app: App, task: Task, log: (msg: string) => void): Promise<PrFound | null> {
  const repo = app.getRepo(task.repo_id);
  const pr = await app.codeHost.prDetails(task.pr!.url!, prCwd(app, task), { withFiles: !!repo && autoMergeOn(task, repo) });
  const state = pr.state;
  if (state !== task.pr?.state) {
    // Guarded on the PR still being open: a merge recorded while GitHub was being asked stays.
    const applied = state === 'closed' ? app.recordPr(task.id, { type: 'closed' }) : app.recordPr(task.id, { type: 'seen', state });
    if (applied) log(`task ${task.id}: PR is ${state}`);
    if (
      applied &&
      state === 'merged' &&
      task.status !== 'done' &&
      (await settle(app, task.id, { type: 'pr_merged' }, { reason: 'PR merged on GitHub' }))
    )
      log(`task ${task.id}: PR merged, task is done`);
  }
  if (state !== 'open' || task.status !== 'done') {
    if (task.pr?.merge_request) dropRequest(app, task.id, state !== 'open' ? `the PR is ${state}` : `the task is ${task.status}`, log);
    return null;
  }
  // The checks kept carry why each failing one failed, so the merge's reasons can say it, and so do the counts kept.
  const kept = await keepChecks(app, task, pr);
  if (checksSettled(pr.checks)) app.recordPrChecksOpened(task.id, pr.check_list ? countOfKept(kept) : pr.checks);
  const judged = pr.check_list ? { ...pr, check_list: kept } : pr;
  // A person asked: the merge request's check stands in for auto-merge's, so the branch is not measured.
  const requested = !!task.pr?.merge_request;
  const auto = requested || !repo ? null : await autoMergeFacts(app, task, repo, judged);
  const verdict = refreshVerdict({ input: mergeInputFor(app, task, repo, judged), requested, auto });
  app.setAutoMergeCheck(task.id, verdict.auto_merge_check);
  if (verdict.drop !== null) {
    if (dropRequest(app, task.id, verdict.drop, log)) notifyLater(app, mergeFailedNotification(task.id, verdict.drop));
    return null;
  }
  if (verdict.request_check) app.setMergeRequestCheck(task.id, verdict.request_check);
  return { pr, place: verdict.place, requested, polling: verdict.polling };
}

/**
 * Re-read the state of every open PR of a done task, and whether it still merges cleanly. A blocked or failed task
 * whose PR was merged becomes done; its mergeability is not read. A failed lookup leaves that task as it was. Resolving the conflicts it finds is the caller's call (`resolveConflicting`).
 */
export async function refreshPrStates(app: App, log: (msg: string) => void = () => {}): Promise<PrRefresh> {
  const found: PrRefresh = { conflicting: [], unknown: 0, mergeable: [], polling: 0 };
  const requested: PrRefresh['mergeable'] = [];
  for (const task of app.openPrTasks()) {
    try {
      const one = await refreshOne(app, task, log);
      if (!one) continue;
      if (one.polling) found.polling++;
      if (one.place === 'conflicting') found.conflicting.push(task.id);
      else if (one.place === 'unknown') found.unknown++;
      else if (one.place === 'mergeable')
        (one.requested ? requested : found.mergeable).push({ id: task.id, pr: one.pr, requested: one.requested });
    } catch (err) {
      log(`task ${task.id}: could not read PR state: ${errorMessage(err)}`);
    }
  }
  found.mergeable.unshift(...requested);
  return found;
}
