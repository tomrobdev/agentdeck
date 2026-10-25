// Keeps task branches up to date with their base branch and resolves merge conflicts.
// The daemon does the git work in the task's worktree (agents cannot fetch); only a real conflict starts a claude run.
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { runClaude } from '../adapters/claude.ts';
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
} from '../adapters/git.ts';
import { github } from '../adapters/github.ts';
import { closeLog, writeEvent } from '../adapters/run-log.ts';
import { lastLine, runCommand } from '../adapters/shell.ts';
import { LOG_DIR, TEST_TIMEOUT_MS, ensureDirs } from '../config.ts';
import type { Db } from '../db/index.ts';
import { conflictReason, syncSummary } from '../domain/pull-request/conflict.ts';
import type { Repo } from '../domain/repo/repo.ts';
import { buildResolvePrompt, claudeArgs } from '../domain/run/prompt.ts';
import { type Run, parseStatus, resultFields } from '../domain/run/run.ts';
import type { Task } from '../domain/task/task.ts';
import { decide } from '../domain/usage/governor.ts';
import { warnStuckDependents } from './dependencies.ts';
import { ActionError } from './errors.ts';
import { notifyLater } from './notifications.ts';
import { logPrEvent } from './pull-requests.ts';
import { effectiveTools, runSettings } from './tools.ts';

/** What bringing the base branch into a task's branch came to. A merge that did not stick is already undone. */
export type BringInResult =
  | { kind: 'up_to_date' }
  | { kind: 'clean' }
  | { kind: 'resolved'; files: string[] }
  /** Conflicts, and no resolve run was allowed. */
  | { kind: 'needs_resolution'; files: string[] }
  /** The resolve run could not fix the conflicts, or the tests failed on the result. */
  | { kind: 'failed'; files: string[]; reason: string }
  | { kind: 'rate_limited'; reason: string }
  | { kind: 'cancelled' }
  /** Git itself failed (no base ref, a lock, …). */
  | { kind: 'error'; reason: string };

interface BringIn {
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
export async function bringInBase(db: Db, task: Task, repo: Repo, worktree: string, opts: BringIn): Promise<BringInResult> {
  let before: string | undefined;
  try {
    // A merge left half done by a crash would otherwise be committed with its markers.
    if (await mergeInProgress(worktree)) await abortMerge(worktree, await headCommit(worktree));
    await commitLeftovers(worktree, `agentdeck: uncommitted work from task ${task.id}\n\n${task.title}`);
    const ref = await startPoint(repo.path, repo.base_branch);
    if (!(await refExists(worktree, ref))) return { kind: 'up_to_date' };

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
    return { kind: 'error', reason: (err as Error).message };
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
): Promise<BringInResult> {
  ensureDirs();
  const prompt = buildResolvePrompt(task, { base: repo.base_branch, files, ...(await mergeSides(worktree)), testCmd: repo.test_cmd });
  const logPath = join(LOG_DIR, `task-${task.id}-resolve-${Date.now()}.jsonl`);
  const log = createWriteStream(logPath, { flags: 'a' });
  const runId = db.startRun(task.id, task.attempts, logPath, 'resolve');
  const { result, exitCode, rateLimitedUntil, cancelled, stderr } = await runClaude({
    args: claudeArgs(task, effectiveTools(repo, worktree), prompt, repo.test_cmd, runSettings(repo, worktree, logPath)),
    cwd: worktree,
    log,
    env: { AGENTDECK_TASK_ID: String(task.id) },
    shouldCancel: () => db.getTask(task.id)?.status === 'cancel_requested',
    onSpawn: (pid) => db.setRunPid(runId, pid),
    onUsage: (w) => db.recordUsageWindow(w.window, w.utilization, w.resets_at, w.status),
  });
  const fields: Partial<Run> = resultFields(result, exitCode);

  let outcome: 'done' | 'blocked' | 'failed' | 'cancelled' | 'rate_limited';
  let reason = '';
  try {
    if (cancelled) {
      outcome = 'cancelled';
    } else if (rateLimitedUntil) {
      db.setSetting('rate_limited_until', String(rateLimitedUntil));
      outcome = 'rate_limited';
      reason = `rate limited until ${new Date(rateLimitedUntil * 1000).toISOString()}`;
    } else if (!result || result.is_error || exitCode !== 0) {
      outcome = 'failed';
      reason = result?.subtype ?? `claude exited with code ${exitCode}${stderr.trim() ? `: ${lastLine(stderr)}` : ''}`;
    } else if (parseStatus(result.result).blocked) {
      outcome = 'blocked';
      reason = parseStatus(result.result).reason ?? 'the agent could not resolve the conflicts';
    } else {
      reason = await checkResolution(worktree, before, files, task);
      if (!reason && runTests && repo.test_cmd) {
        const tests = await runCommand(repo.test_cmd, worktree, TEST_TIMEOUT_MS);
        writeEvent(log, { type: 'agentdeck_tests', passed: tests.passed, output: tests.output });
        fields.tests_passed = tests.passed ? 1 : 0;
        if (!tests.passed) reason = `tests failed: ${lastLine(tests.output)}`;
      }
      outcome = reason ? 'failed' : 'done';
    }
  } catch (err) {
    outcome = 'failed';
    reason = (err as Error).message;
  }

  if (outcome !== 'done') await abortMerge(worktree, before).catch(() => {});
  await closeLog(log);
  db.finishRun(runId, { ...fields, outcome, ...(reason && !fields.result_text ? { result_text: reason } : {}) });

  switch (outcome) {
    case 'done':
      return { kind: 'resolved', files };
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'rate_limited':
      return { kind: 'rate_limited', reason };
    default:
      return { kind: 'failed', files, reason };
  }
}

/** After a resolve run said it was done: conclude the merge and say what is wrong with it, or '' when nothing is. */
async function checkResolution(worktree: string, before: string, files: string[], task: Task): Promise<string> {
  const marked = filesWithMarkers(worktree, files);
  if (marked.length) return `conflict markers are still in ${marked.join(', ')}`;
  await concludeMerge(worktree);
  await commitLeftovers(worktree, `agentdeck: uncommitted work from task ${task.id}\n\n${task.title}`);
  if ((await mergeInProgress(worktree)) || (await conflictedFiles(worktree)).length) return 'the merge was left unfinished';
  if ((await headCommit(worktree)) === before) return 'the merge was not committed';
  return '';
}

/** The branch merge is the daemon's only write to a done task's worktree: one at a time per task. */
const syncing = new Set<number>();

/** Whether a sync or resolve run is touching this task's worktree right now, in this process or the daemon's. */
export const isSyncing = (db: Db, id: number): boolean => syncing.has(id) || db.hasRunningResolve(id);

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
  if (!task.branch || !task.pr_url || task.pr_state !== 'open') return { pushed: false };
  try {
    // A branch that was merged but not pushed (the push failed last time) still needs pushing.
    if (!changed && !(await aheadOfRemote(worktree, task.branch))) return { pushed: false };
    await github.push(repo.path, task.branch);
    return { pushed: true };
  } catch (err) {
    const error = (err as Error).message;
    logPrEvent(db, task.id, { error });
    return { pushed: false, error };
  }
}

/**
 * Bring the base into a done task's branch: the merge, the repo's tests, and a push to its open PR; a conflict
 * starts a resolve run. The task stays done. If the conflicts cannot be resolved, or the tests fail on the merged
 * branch, the merge is undone and the task becomes blocked with the conflicting files as the reason.
 * `manual` is a person asking (it ignores the repo's auto_resolve and throws what an automatic call only reports).
 */
export async function syncTask(db: Db, id: number, opts: { manual: boolean }): Promise<SyncReport> {
  const task = db.getTask(id);
  if (!task) throw new ActionError('no such task');
  const repo = db.getRepo(task.repo_id);
  if (!repo) throw new ActionError('the task has no repo');
  if (task.status !== 'done') throw new ActionError(`#${id} is ${task.status}; only a done task's branch is brought up to date this way`);
  if (!task.branch) throw new ActionError(`#${id} has no branch`);
  if (syncing.has(id)) throw new ActionError(`#${id} is already being brought up to date`);

  syncing.add(id);
  try {
    const wt = await ensureWorktree(repo, task);
    if (wt.path !== task.worktree) db.updateTask(id, { worktree: wt.path });
    const res = await bringInBase(db, task, repo, wt.path, { allowResolve: opts.manual || repo.auto_resolve === 1, runTests: true });
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
        const blocked = db.applyEvent(id, { type: 'conflict' }, { reason });
        if (blocked) {
          warnStuckDependents(db, id);
          notifyLater(db, {
            kind: 'blocked',
            title: `#${id} blocked: ${task.title}`,
            body: `${reason} (${repo.name})`,
            task_id: id,
          });
        }
        return { outcome: 'blocked', files: res.files, reason, pushed: false };
      }
      case 'rate_limited':
        return { outcome: 'deferred', files: [], reason: res.reason, pushed: false };
      case 'cancelled':
        return { outcome: 'deferred', files: [], reason: 'cancelled', pushed: false };
      case 'error':
        if (opts.manual) throw new ActionError(`could not bring in ${repo.base_branch}: ${res.reason}`);
        return { outcome: 'error', files: [], reason: res.reason, pushed: false };
    }
  } finally {
    syncing.delete(id);
  }
}

/** A person asked (`agentdeck resolve`, the merge dialog's button): the repo's auto_resolve does not apply. */
export const resolveTask = (db: Db, id: number): Promise<SyncReport> => syncTask(db, id, { manual: true });

/** Whether the governor lets a conflict run start now: not paused, not rate limited, inside the usage windows, a slot free. */
export function canStartResolve(db: Db): boolean {
  if (db.isPaused()) return false;
  if (Number(db.getSetting('rate_limited_until', '0')) * 1000 > Date.now()) return false;
  const d = decide(db.usageWindows(), db.budget(), db.maxConcurrent());
  return d.allow && db.countRunning() + syncing.size < d.max_concurrent;
}

/**
 * Bring the base into the open PRs that GitHub reports as conflicting, one at a time, as far as the governor allows.
 * The rest are left for the next refresh. Never throws.
 */
export async function resolveConflicting(db: Db, ids: number[], log: (msg: string) => void = () => {}): Promise<void> {
  for (const id of ids) {
    const task = db.getTask(id);
    const repo = task && db.getRepo(task.repo_id);
    if (!task || !repo || task.status !== 'done' || repo.paused_reason || syncing.has(id)) continue;
    if (!canStartResolve(db)) {
      log(`task ${id}: PR conflicts with ${repo.base_branch}; waiting for the governor before resolving`);
      return;
    }
    log(`task ${id}: PR conflicts with ${repo.base_branch}; bringing it in`);
    try {
      const r = await syncTask(db, id, { manual: false });
      log(`task ${id}: ${r.outcome}${r.reason ? ` (${r.reason})` : ''}${r.push_error ? `; push failed: ${r.push_error}` : ''}`);
    } catch (err) {
      log(`task ${id}: could not bring in ${repo.base_branch}: ${(err as Error).message}`);
    }
  }
}
