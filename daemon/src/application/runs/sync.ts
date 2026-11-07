// Syncs task branches with their base branch; a conflict starts a resolve run.
// The daemon does the git work in the task's worktree (agents cannot fetch); only a real conflict starts a claude run.
import {
  abortMerge,
  aheadOfRemote,
  commitLeftovers,
  concludeMerge,
  conflictedFiles,
  ensureWorktree,
  filesWithMarkers,
  headCommit,
  mergeInProgress,
  mergeRef,
  mergeSides,
  refExists,
  startPoint,
} from '../../adapters/git.ts';
import { github } from '../../adapters/github.ts';
import { writeEvent } from '../../adapters/run-log.ts';
import { runCommand } from '../../adapters/shell.ts';
import { TEST_TIMEOUT_MS } from '../../config.ts';
import type { Db } from '../../db/index.ts';
import type { TaskId } from '../../domain/shared/id.ts';
import { type SyncResult, conflictReason, syncResultOf, syncSummary } from '../../domain/landing/sync.ts';
import type { Repo } from '../../domain/repos/repo.ts';
import { buildResolvePrompt } from '../../domain/runs/prompt.ts';
import { resolveOutcome } from '../../domain/runs/resolve.ts';
import type { Outcome, Run } from '../../domain/runs/run.ts';
import { errorMessage, lastLine } from '../../domain/shared/text.ts';
import { openPrUrl } from '../../domain/landing/pr.ts';
import { type Task, leftoversMessage } from '../../domain/work/task.ts';
import { endTaskRun, openTaskRun, startTaskRun } from './claude-run.ts';
import { ActionError, requireTask, requireTaskRepo } from '../shared/input.ts';
import { queueWait } from '../capacity/gate.ts';
import { logPrEvent } from '../landing/open-pr.ts';
import { settle } from '../landing/settle.ts';
import { isMergeLocked, isSyncLocked, isSyncing, lockSync, markSyncing, unlockSync } from '../work/checkout-locks.ts';

interface SyncOptions {
  /** A resolve run may start when the merge conflicts. */
  allowResolve: boolean;
  /** Run the repo's test command on the merged result (a done task's branch; a run about to start will be tested later). */
  runTests: boolean;
}

/**
 * Merge the latest base into the task's branch in its worktree: fetch, then merge origin/<base> (the local base
 * when the repo has no origin). Clean: git commits it. Conflicts: the markers stay and a resolve run (its own kind
 * of run, which uses no attempt) fixes them. If that fails, the merge is aborted and the branch is left as it was.
 * Never throws.
 */
export async function syncBranch(db: Db, task: Task, repo: Repo, worktree: string, opts: SyncOptions): Promise<SyncResult> {
  let before: string | undefined;
  try {
    // A merge left half done by a crash would otherwise be committed with its markers.
    if (await mergeInProgress(worktree)) await abortMerge(worktree, await headCommit(worktree));
    await commitLeftovers(worktree, leftoversMessage(task));
    const ref = await startPoint(repo.path, repo.base_branch);
    if (!(await refExists(worktree, ref))) {
      const reason = `there is no ${ref} to sync with`;
      console.error(`task ${task.id}: ${reason}`);
      return { kind: 'error', reason };
    }

    before = await headCommit(worktree);
    const merge = await mergeRef(worktree, ref);
    if (merge.kind === 'up_to_date') return merge;
    if (merge.kind === 'merged') {
      if (opts.runTests && repo.test_cmd) {
        const tests = await runCommand(repo.test_cmd, worktree, TEST_TIMEOUT_MS);
        if (!tests.passed) {
          await abortMerge(worktree, before);
          return { kind: 'failed', files: [], reason: `tests failed after merging ${repo.base_branch}: ${lastLine(tests.output)}` };
        }
      }
      return { kind: 'clean' };
    }
    if (!opts.allowResolve) {
      await abortMerge(worktree, before);
      return { kind: 'needs_resolution', files: merge.files };
    }
    return await resolveConflicts(db, task, repo, worktree, before, merge.files, opts.runTests);
  } catch (err) {
    if (before) await abortMerge(worktree, before).catch(() => {});
    return { kind: 'error', reason: errorMessage(err) };
  }
}

/** The merge is in progress with conflicts: run claude on it, check what it left, and keep or undo the merge. */
async function resolveConflicts(
  db: Db,
  task: Task,
  repo: Repo,
  worktree: string,
  before: string,
  files: string[],
  runTests: boolean,
): Promise<SyncResult> {
  const prompt = buildResolvePrompt(task, { base: repo.base_branch, files, ...(await mergeSides(worktree)), testCmd: repo.test_cmd });
  const opened = openTaskRun(db, task, 'resolve');
  const { log } = opened;
  let fields: Partial<Run> = {};

  let outcome: Outcome;
  let reason = '';
  try {
    // Throws if the run cannot start (no settings, no worktree): the row still ends below, failed.
    const ran = await startTaskRun(db, task, { kind: 'resolve', repo, worktree, prompt, opened });
    fields = ran.fields;
    const settled = resolveOutcome(ran.end);
    if (settled.outcome !== 'check') {
      outcome = settled.outcome;
      reason = 'reason' in settled ? settled.reason : '';
    } else {
      reason = await checkResolution(worktree, before, files, task);
      if (!reason && runTests && repo.test_cmd) {
        const tests = await runCommand(repo.test_cmd, worktree, TEST_TIMEOUT_MS);
        writeEvent(log, { type: 'agentdeck_tests', passed: tests.passed, output: tests.output });
        fields.tests_passed = tests.passed;
        if (!tests.passed) reason = `tests failed: ${lastLine(tests.output)}`;
      }
      outcome = reason ? 'failed' : 'done';
    }
  } catch (err) {
    outcome = 'failed';
    reason = errorMessage(err);
  }

  if (outcome !== 'done') await abortMerge(worktree, before).catch(() => {});
  await endTaskRun(db, opened, outcome, reason, fields);

  return syncResultOf(outcome, files, reason);
}

/** After a resolve run said it was done: conclude the merge and say what is wrong with it, or '' when nothing is. */
async function checkResolution(worktree: string, before: string, files: string[], task: Task): Promise<string> {
  const marked = filesWithMarkers(worktree, files);
  if (marked.length) return `conflict markers are still in ${marked.join(', ')}`;
  await concludeMerge(worktree);
  await commitLeftovers(worktree, leftoversMessage(task));
  if ((await mergeInProgress(worktree)) || (await conflictedFiles(worktree)).length) return 'the merge was left unfinished';
  if ((await headCommit(worktree)) === before) return 'the merge was not committed';
  return '';
}

export interface SyncReport {
  /** `skipped`: conflicts, but auto_resolve is off. `deferred`: the usage limit, or a cancel, stopped it. */
  outcome: 'up_to_date' | 'clean' | 'resolved' | 'blocked' | 'skipped' | 'deferred' | 'error';
  files: string[];
  reason?: string;
  /** The branch was pushed, so the PR has it. */
  pushed: boolean;
  push_error?: string;
}

/** Push the branch if the task has an open PR that does not have its latest commits yet. Returns an error message, if any. */
async function pushIfNeeded(
  db: Db,
  task: Task,
  repo: Repo,
  worktree: string,
  changed: boolean,
): Promise<{ pushed: boolean; error?: string }> {
  const branch = task.checkout?.branch;
  if (!branch || !openPrUrl(task.pr)) return { pushed: false };
  try {
    // A branch that was merged but not pushed (the push failed last time) still needs pushing.
    if (!changed && !(await aheadOfRemote(worktree, branch))) return { pushed: false };
    await github.push(repo.path, branch);
    return { pushed: true };
  } catch (err) {
    const error = errorMessage(err);
    logPrEvent(db, task.id, { error });
    return { pushed: false, error };
  }
}

/**
 * Sync a done task's branch with the base: the merge, the repo's tests, and a push to its open PR; a conflict
 * starts a resolve run. The task stays done. If the conflicts cannot be resolved, or the tests fail on the merged
 * branch, the merge is undone and the task becomes blocked with the conflicting files as the reason.
 * `manual` is a person asking (it ignores the repo's auto_resolve and throws what an automatic call only reports).
 */
export async function syncTask(db: Db, id: TaskId, opts: { manual: boolean }): Promise<SyncReport> {
  const task = requireTask(db, id);
  const repo = requireTaskRepo(db, task);
  if (task.status !== 'done') throw new ActionError(`#${id} is ${task.status}; only a done task's branch is synced this way`);
  if (!task.checkout?.branch) throw new ActionError(`#${id} has no branch`);
  if (isSyncLocked(id) || db.hasSyncMarker(id)) throw new ActionError(`#${id} is already syncing`);
  if (isMergeLocked(id)) throw new ActionError(`#${id} is being merged; try again when that is done`);

  lockSync(id);
  try {
    return await markSyncing(db, id, () => syncMarked(db, task, repo, opts));
  } finally {
    unlockSync(id);
  }
}

async function syncMarked(db: Db, task: Task, repo: Repo, opts: { manual: boolean }): Promise<SyncReport> {
  const id = task.id;
  const wt = await ensureWorktree(repo, task);
  if (wt.path !== task.checkout?.worktree) db.setCheckout(id, { worktree: wt.path });
  const res = await syncBranch(db, task, repo, wt.path, { allowResolve: opts.manual || repo.auto_resolve, runTests: true });
  switch (res.kind) {
    case 'up_to_date':
    case 'clean':
    case 'resolved': {
      const changed = res.kind !== 'up_to_date';
      if (res.kind !== 'up_to_date') {
        db.recordSync(id, syncSummary(repo.base_branch, res.kind, res.kind === 'resolved' ? res.files : []));
      }
      const push = await pushIfNeeded(db, task, repo, wt.path, changed);
      return { outcome: res.kind, files: res.kind === 'resolved' ? res.files : [], pushed: push.pushed, push_error: push.error };
    }
    case 'needs_resolution':
      return { outcome: 'skipped', files: res.files, reason: 'the repo has auto_resolve off', pushed: false };
    case 'failed': {
      const reason = conflictReason(repo.base_branch, res.files, res.reason);
      await settle(db, id, { type: 'conflict' }, { reason });
      return { outcome: 'blocked', files: res.files, reason, pushed: false };
    }
    case 'rate_limited':
      return { outcome: 'deferred', files: [], reason: res.reason, pushed: false };
    case 'cancelled':
      return { outcome: 'deferred', files: [], reason: 'cancelled', pushed: false };
    case 'error':
      if (opts.manual) throw new ActionError(`could not sync with ${repo.base_branch}: ${res.reason}`);
      return { outcome: 'error', files: [], reason: res.reason, pushed: false };
  }
}

/** A person asked (`agentdeck sync`, the dashboard's sync button): the repo's auto_resolve does not apply. */
export const syncNow = (db: Db, id: TaskId): Promise<SyncReport> => syncTask(db, id, { manual: true });

/** Whether the governor lets a resolve run start now: not paused, not rate limited, inside the usage windows, a slot free. */
export function canStartResolve(db: Db): boolean {
  return queueWait(db).free > 0;
}

/**
 * Sync the open PRs that GitHub reports as conflicting with the base, one at a time, as far as the governor allows.
 * The rest are left for the next refresh. A repo with auto_resolve off is not touched: its tasks wait for a person's
 * sync, said once per conflict while `told` is kept between calls. Never throws.
 */
export async function resolveConflicting(
  db: Db,
  ids: TaskId[],
  log: (msg: string) => void = () => {},
  told: Set<TaskId> = new Set(),
): Promise<void> {
  for (const id of told) if (!ids.includes(id)) told.delete(id);
  for (const id of ids) {
    const task = db.getTask(id);
    const repo = task && db.getRepo(task.repo_id);
    if (!task || !repo || task.status !== 'done' || repo.paused_reason || isSyncing(db, id) || isMergeLocked(id)) continue;
    if (!repo.auto_resolve) {
      if (!told.has(id)) {
        told.add(id);
        log(`task ${id}: PR conflicts with ${repo.base_branch}; auto_resolve is off, so it waits for a sync (agentdeck sync ${id})`);
      }
      continue;
    }
    if (!canStartResolve(db)) {
      log(`task ${id}: PR conflicts with ${repo.base_branch}; waiting for the governor before syncing`);
      return;
    }
    log(`task ${id}: PR conflicts with ${repo.base_branch}; syncing it with ${repo.base_branch}`);
    try {
      const r = await syncTask(db, id, { manual: false });
      log(`task ${id}: ${r.outcome}${r.reason ? ` (${r.reason})` : ''}${r.push_error ? `; push failed: ${r.push_error}` : ''}`);
    } catch (err) {
      log(`task ${id}: could not sync with ${repo.base_branch}: ${errorMessage(err)}`);
    }
  }
}
