// The PR refresh: keep the state of open PRs fresh, and say which ones conflict or are ready to merge.
import type { App } from '../ports/app.ts';
import type { TaskId } from '../../domain/shared/index.ts';
import type { PrCheck, PrDetails } from '../../domain/landing/index.ts';
import { type AutoMergeCheck, autoMergeCheck, autoMergeOn } from '../../domain/landing/index.ts';
import { carryFailures, checksSettled, nextChecks } from '../../domain/landing/index.ts';
import { readFailure } from './check-failures.ts';
import { checksFailedNotification } from '../../domain/operations/index.ts';
import { isConflicting, isMergeabilityUnknown } from '../../domain/landing/index.ts';
import { mergeRequestCheck, mergeRequestPolls } from '../../domain/landing/index.ts';
import { type Repo, pausedReason } from '../../domain/repos/index.ts';
import type { Task } from '../../domain/work/index.ts';
import { errorMessage } from '../../domain/shared/index.ts';
import { landsAfter } from '../work/dependencies.ts';
import { measureBranch } from '../work/files.ts';
import { settle, settlePr } from './settle.ts';
import { notifyLater } from '../operations/notifications.ts';

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
 * The auto-merge check for a task's PR (read `withFiles`), or null when auto-merge is off for the task. Its size is counted
 * from git (`git diff --numstat` against the base in the repo's checkout) when the local branch is at the PR's head, since
 * GitHub's file list stops at 100; from GitHub's numbers otherwise.
 */
export async function autoMergeFor(
  app: App,
  task: Task,
  repo: Repo,
  pr: PrDetails,
  tests_passed: boolean | null,
): Promise<AutoMergeCheck | null> {
  if (!autoMergeOn(task, repo)) return null;
  const branch = task.checkout?.branch;
  const measured = branch && pr.head ? await measureBranch(app, repo, branch, pr.head) : null;
  return autoMergeCheck({
    measured,
    repo,
    pr_state: task.pr?.state ?? null,
    pr,
    tests_passed,
    lands_after: landsAfter(app, task.id),
    auto_resolve: repo.auto_resolve,
    paused: pausedReason(app.isPaused(), repo),
  });
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

/** Where a PR goes in a refresh's findings: it conflicts with the base, GitHub has not worked out its mergeability, it is ready to merge, or none of these. */
export type PrPlace = 'conflicting' | 'unknown' | 'mergeable' | null;

/** Where a PR goes in a refresh's findings, from what GitHub said and its check's verdict (null with no check). A PR that is not open goes nowhere. */
export function classify(pr: Pick<PrDetails, 'state' | 'mergeable' | 'merge_state'>, verdict: AutoMergeCheck['verdict'] | null): PrPlace {
  if (pr.state !== 'open') return null;
  if (isConflicting(pr)) return 'conflicting';
  if (isMergeabilityUnknown(pr)) return 'unknown';
  return verdict === 'merge' ? 'mergeable' : null;
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
    const applied = state === 'closed' ? settlePr(app, task.id, { type: 'closed' }) : app.recordPr(task.id, { type: 'seen', state });
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
  if (checksSettled(pr.checks)) app.recordPrChecksOpened(task.id, pr.checks);
  // The checks kept carry why each failing one failed, so the merge's reasons can say it.
  const kept = await keepChecks(app, task, pr);
  const judged = pr.check_list ? { ...pr, check_list: kept } : pr;
  const tests = lastTestsPassed(app, task.id);
  if (task.pr?.merge_request) {
    // A person asked: the merge request's check stands in for auto-merge's.
    const check = mergeRequestCheck({
      pr_state: task.pr.state,
      pr: judged,
      tests_passed: tests,
      lands_after: landsAfter(app, task.id),
      auto_resolve: repo ? repo.auto_resolve : true,
    });
    app.setAutoMergeCheck(task.id, null);
    if (check.verdict === 'never') {
      const why = check.reasons.join('; ');
      if (dropRequest(app, task.id, why, log))
        notifyLater(app, { kind: 'merged', title: `Could not merge #${task.id}`, body: why, task_id: task.id });
      return null;
    }
    app.setMergeRequestCheck(task.id, check);
    return { pr, place: classify(pr, check.verdict), requested: true, polling: mergeRequestPolls(check, pr) };
  }
  // Every check is kept on the task for the views, whatever the verdict; none when auto-merge is off.
  const check = repo ? await autoMergeFor(app, task, repo, judged, tests) : null;
  app.setAutoMergeCheck(task.id, check);
  return { pr, place: classify(pr, check?.verdict ?? null), requested: false, polling: false };
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
