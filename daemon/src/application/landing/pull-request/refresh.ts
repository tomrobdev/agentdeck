// The PR refresh: keep the state of open PRs fresh, and say which ones conflict or are ready to merge.
import type { App } from '#application/ports/app.ts';
import type { TaskId } from '#domain/shared/index.ts';
import type { AutoMergeFacts, MergeInput, PrCheck, PrDetails, PrPlace, ReviewFacts } from '#domain/landing/index.ts';
import { type AutoMergeCheck, autoMergeCheck, autoMergeOn, refreshVerdict } from '#domain/landing/index.ts';
import { carryFailures, checksSettled, countOfKept, nextChecks, withCheckList } from '#domain/landing/index.ts';
import { readFailure } from '#application/landing/pull-request/check-failures.ts';
import { checksFailedNotification, mergeFailedNotification } from '#domain/operations/index.ts';
import { type Repo, pausedReason } from '#domain/repos/index.ts';
import { type PrEvent, type Task, targetOf } from '#domain/work/index.ts';
import { errorMessage, present } from '#domain/shared/index.ts';
import { landsAfter } from '#application/work/dependencies.ts';
import { measureBranch } from '#application/work/files.ts';
import { endMergeRequest, movePr } from '#application/landing/moves.ts';
import { settle } from '#application/landing/settle.ts';
import { notifyLater } from '#application/operations/notifications.ts';

export const PR_REFRESH_MS = 3 * 60_000;
export const MERGE_REQUEST_POLL_MS = 30_000;

export function prCwd(app: App, task: Task): string {
  return app.getRepo(task.repo_id)?.path ?? process.cwd();
}

export function lastTestsPassed(app: App, id: TaskId): boolean | null {
  return app.runsForTask(id).findLast((r) => r.tests_passed !== null)?.tests_passed ?? null;
}

export function mergeInputFor(app: App, task: Task, repo: Repo | undefined, pr: PrDetails): MergeInput {
  return {
    pr_state: task.pr?.state ?? null,
    pr,
    tests_passed: lastTestsPassed(app, task.id),
    lands_after: landsAfter(app, task.id),
    auto_resolve: repo ? repo.auto_resolve : true,
    ci_not_run_ok: repo?.ci_not_run_ok ?? false,
  };
}

async function autoMergeFacts(app: App, task: Task, repo: Repo, pr: PrDetails): Promise<AutoMergeFacts | null> {
  if (!autoMergeOn(task, repo)) return null;
  const branch = task.checkout?.branch;
  const [measured, review] = await Promise.all([
    branch && pr.head ? measureBranch(app, repo, task, branch, pr.head) : null,
    repo.auto_review ? reviewFacts(app, task, repo, pr) : null,
  ]);
  return { repo, paused: pausedReason(app.isPaused(), repo), measured, review };
}

async function reviewFacts(app: App, task: Task, repo: Repo, pr: PrDetails): Promise<ReviewFacts> {
  const diff_hash = pr.head ? await app.workspace.diffHash(repo.path, targetOf(task, repo), pr.head).catch(() => null) : null;
  return { diff_hash, reviews: app.reviewsForTask(task.id), runs: app.runsForTask(task.id) };
}

export async function autoMergeFor(app: App, task: Task, repo: Repo, input: MergeInput): Promise<AutoMergeCheck | null> {
  const facts = await autoMergeFacts(app, task, repo, input.pr);
  return facts && autoMergeCheck({ ...input, ...facts });
}

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

export interface ReadyPr {
  id: TaskId;
  pr: PrDetails;
  requested: boolean;
}

export interface PrRefresh {
  conflicting: TaskId[];
  unknown: number;
  mergeable: ReadyPr[];
  polling: number;
}

interface PrFound {
  pr: PrDetails;
  place: PrPlace;
  requested: boolean;
  polling: boolean;
}

function dropRequest(app: App, task: Task, move: 'dropped' | 'refused', why: string, log: (msg: string) => void): boolean {
  if (!endMergeRequest(app, task, move, log)) return false;
  log(`task ${task.id}: merge request dropped: ${why}`);
  return true;
}

async function refreshOne(app: App, task: Task, log: (msg: string) => void): Promise<PrFound | null> {
  const repo = app.getRepo(task.repo_id);
  const pr = await app.codeHost.prDetails(present(task.pr?.url, `#${task.id}'s pull request`), prCwd(app, task), {
    withFiles: !!repo && autoMergeOn(task, repo),
  });
  const state = pr.state;
  if (state !== task.pr?.state) {
    const event: PrEvent = state === 'closed' ? { type: 'closed' } : { type: 'seen', state };
    const applied = movePr(app, task, event, log) !== null;
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
    if (task.pr?.merge_request)
      dropRequest(app, task, 'dropped', state !== 'open' ? `the PR is ${state}` : `the task is ${task.status}`, log);
    return null;
  }
  const kept = await keepChecks(app, task, pr);
  if (checksSettled(pr.checks)) app.recordPrChecksOpened(task.id, pr.check_list ? countOfKept(kept) : pr.checks);
  const judged = withCheckList(pr, kept);
  const requested = !!task.pr?.merge_request;
  const auto = requested || !repo ? null : await autoMergeFacts(app, task, repo, judged);
  const verdict = refreshVerdict({ input: mergeInputFor(app, task, repo, judged), requested, auto });
  app.setAutoMergeCheck(task.id, verdict.auto_merge_check);
  if (verdict.drop !== null) {
    if (dropRequest(app, task, 'refused', verdict.drop, log)) notifyLater(app, mergeFailedNotification(task.id, verdict.drop));
    return null;
  }
  if (verdict.request_check) app.setMergeRequestCheck(task.id, verdict.request_check);
  return { pr, place: verdict.place, requested, polling: verdict.polling };
}

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
