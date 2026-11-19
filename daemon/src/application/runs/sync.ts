// Syncs task branches with their base branch; a conflict starts a resolve run.
import { TEST_TIMEOUT_MS } from '#src/config.ts';
import type { App } from '#application/ports/app.ts';
import type { SyncFinish } from '#application/ports/workspace.ts';
import type { TaskId } from '#domain/shared/index.ts';
import { type SyncResult, conflictReason, syncResultOf, syncSummary } from '#domain/runs/index.ts';
import type { Repo } from '#domain/repos/index.ts';
import { buildResolvePrompt } from '#domain/runs/index.ts';
import { resolveOutcome } from '#domain/runs/index.ts';
import type { Outcome, Run } from '#domain/runs/index.ts';
import { errorMessage, lastLine } from '#domain/shared/index.ts';
import { openPrUrl } from '#domain/landing/index.ts';
import { type Task, leftoversMessage, targetOf } from '#domain/work/index.ts';
import { endTaskRun, openTaskRun, startTaskRun } from '#application/runs/claude-run.ts';
import { ActionError, requireTask, requireTaskRepo } from '#application/shared/input.ts';
import { queueWait } from '#application/capacity/gate.ts';
import { logPrEvent } from '#application/landing/pull-request/open-pr.ts';
import { settle } from '#application/landing/settle.ts';
import { isMergeLocked, isSyncLocked, isSyncing, lockSync, markSyncing, unlockSync } from '#application/work/checkout-locks.ts';

interface SyncOptions {
  allowResolve: boolean;
  runTests: boolean;
}

export async function syncBranch(app: App, task: Task, repo: Repo, worktree: string, opts: SyncOptions): Promise<SyncResult> {
  const ws = app.workspace;
  let before: string | undefined;
  try {
    const merge = await ws.startSync(repo, targetOf(task, repo), worktree, leftoversMessage(task));
    if (merge.kind === 'no_base') {
      const reason = `there is no ${merge.ref} to sync with`;
      console.error(`task ${task.id}: ${reason}`);
      return { kind: 'error', reason };
    }
    if (merge.kind === 'up_to_date') return merge;
    before = merge.before;
    if (merge.kind === 'merged') {
      if (opts.runTests && repo.test_cmd) {
        const tests = await ws.runCommand(repo.test_cmd, worktree, TEST_TIMEOUT_MS);
        if (!tests.passed) {
          await ws.undoSync(worktree, before);
          return { kind: 'failed', files: [], reason: `tests failed after merging ${targetOf(task, repo)}: ${lastLine(tests.output)}` };
        }
      }
      return { kind: 'clean' };
    }
    if (!opts.allowResolve) {
      await ws.undoSync(worktree, before);
      return { kind: 'needs_resolution', files: merge.files };
    }
    const { files, ours, theirs } = merge;
    return await resolveConflicts(app, task, repo, worktree, before, { files, ours, theirs }, opts.runTests);
  } catch (err) {
    if (before) await ws.undoSync(worktree, before).catch(() => {});
    return { kind: 'error', reason: errorMessage(err) };
  }
}

async function resolveConflicts(
  app: App,
  task: Task,
  repo: Repo,
  worktree: string,
  before: string,
  conflict: { files: string[]; ours: string[]; theirs: string[] },
  runTests: boolean,
): Promise<SyncResult> {
  const { files } = conflict;
  const prompt = buildResolvePrompt(task, { base: targetOf(task, repo), ...conflict, testCmd: repo.test_cmd });
  const opened = openTaskRun(app, task, 'resolve');
  const { log } = opened;
  let fields: Partial<Run> = {};

  let outcome: Outcome;
  let reason = '';
  try {
    const ran = await startTaskRun(app, task, { kind: 'resolve', repo, worktree, prompt, opened });
    fields = ran.fields;
    const settled = resolveOutcome(ran.end);
    if (settled.outcome !== 'check') {
      outcome = settled.outcome;
      reason = 'reason' in settled ? settled.reason : '';
    } else {
      reason = resolutionProblem(await app.workspace.finishSync(worktree, files, before, leftoversMessage(task)));
      if (!reason && runTests && repo.test_cmd) {
        const tests = await app.workspace.runCommand(repo.test_cmd, worktree, TEST_TIMEOUT_MS);
        app.runLog.event(log, { type: 'agentdeck_tests', passed: tests.passed, output: tests.output });
        fields.tests_passed = tests.passed;
        if (!tests.passed) reason = `tests failed: ${lastLine(tests.output)}`;
      }
      outcome = reason ? 'failed' : 'done';
    }
  } catch (err) {
    outcome = 'failed';
    reason = errorMessage(err);
  }

  if (outcome !== 'done') await app.workspace.undoSync(worktree, before).catch(() => {});
  await endTaskRun(app, opened, outcome, reason, fields);

  return syncResultOf(outcome, files, reason);
}

export function resolutionProblem(finish: SyncFinish): string {
  switch (finish.kind) {
    case 'markers':
      return `conflict markers are still in ${finish.files.join(', ')}`;
    case 'unfinished':
      return 'the merge was left unfinished';
    case 'not_committed':
      return 'the merge was not committed';
    case 'done':
      return '';
  }
}

export interface SyncReport {
  outcome: 'up_to_date' | 'clean' | 'resolved' | 'blocked' | 'skipped' | 'deferred' | 'error';
  files: string[];
  reason?: string;
  pushed: boolean;
  push_error?: string;
}

async function pushIfNeeded(
  app: App,
  task: Task,
  repo: Repo,
  worktree: string,
  changed: boolean,
): Promise<{ pushed: boolean; error?: string }> {
  const branch = task.checkout?.branch;
  if (!branch || !openPrUrl(task.pr)) return { pushed: false };
  try {
    if (!changed && !(await app.workspace.unpushedCommits(worktree, branch))) return { pushed: false };
    await app.codeHost.push(repo.path, branch);
    return { pushed: true };
  } catch (err) {
    const error = errorMessage(err);
    logPrEvent(app, task.id, { error });
    return { pushed: false, error };
  }
}

export async function syncTask(app: App, id: TaskId, opts: { manual: boolean }): Promise<SyncReport> {
  const task = requireTask(app, id);
  const repo = requireTaskRepo(app, task);
  if (task.status !== 'done') throw new ActionError(`#${id} is ${task.status}; only a done task's branch is synced this way`);
  if (!task.checkout?.branch) throw new ActionError(`#${id} has no branch`);
  if (isSyncLocked(id) || app.hasSyncMarker(id)) throw new ActionError(`#${id} is already syncing`, undefined, 'conflict');
  if (isMergeLocked(id)) throw new ActionError(`#${id} is being merged; try again when that is done`, undefined, 'conflict');

  lockSync(id);
  try {
    return await markSyncing(app, id, () => syncMarked(app, task, repo, opts));
  } finally {
    unlockSync(id);
  }
}

async function syncMarked(app: App, task: Task, repo: Repo, opts: { manual: boolean }): Promise<SyncReport> {
  const id = task.id;
  const target = targetOf(task, repo);
  const wt = await app.workspace.prepareCheckout(repo, task, target);
  if (wt.path !== task.checkout?.worktree) app.setCheckout(id, { worktree: wt.path });
  const res = await syncBranch(app, task, repo, wt.path, { allowResolve: opts.manual || repo.auto_resolve, runTests: true });
  switch (res.kind) {
    case 'up_to_date':
    case 'clean':
    case 'resolved': {
      const changed = res.kind !== 'up_to_date';
      if (res.kind !== 'up_to_date') {
        app.recordSync(id, syncSummary(target, res.kind, res.kind === 'resolved' ? res.files : []));
      }
      const push = await pushIfNeeded(app, task, repo, wt.path, changed);
      return { outcome: res.kind, files: res.kind === 'resolved' ? res.files : [], pushed: push.pushed, push_error: push.error };
    }
    case 'needs_resolution':
      return { outcome: 'skipped', files: res.files, reason: 'the repo has auto_resolve off', pushed: false };
    case 'failed': {
      const reason = conflictReason(target, res.files, res.reason);
      await settle(app, id, { type: 'conflict' }, { reason });
      return { outcome: 'blocked', files: res.files, reason, pushed: false };
    }
    case 'rate_limited':
      return { outcome: 'deferred', files: [], reason: res.reason, pushed: false };
    case 'cancelled':
      return { outcome: 'deferred', files: [], reason: 'cancelled', pushed: false };
    case 'error':
      if (opts.manual) throw new ActionError(`could not sync with ${target}: ${res.reason}`, undefined, 'conflict');
      return { outcome: 'error', files: [], reason: res.reason, pushed: false };
  }
}

export const syncNow = (app: App, id: TaskId): Promise<SyncReport> => syncTask(app, id, { manual: true });

export function canStartResolve(app: App): boolean {
  return queueWait(app).free > 0;
}

export async function resolveConflicting(
  app: App,
  ids: TaskId[],
  log: (msg: string) => void = () => {},
  told: Set<TaskId> = new Set(),
): Promise<void> {
  for (const id of told) if (!ids.includes(id)) told.delete(id);
  for (const id of ids) {
    const task = app.getTask(id);
    const repo = task && app.getRepo(task.repo_id);
    if (!task || !repo || task.status !== 'done' || repo.paused_reason || isSyncing(app, id) || isMergeLocked(id)) continue;
    const target = targetOf(task, repo);
    if (!repo.auto_resolve) {
      if (!told.has(id)) {
        told.add(id);
        log(`task ${id}: PR conflicts with ${target}; auto_resolve is off, so it waits for a sync (agentdeck sync ${id})`);
      }
      continue;
    }
    if (!canStartResolve(app)) {
      log(`task ${id}: PR conflicts with ${target}; waiting for the governor before syncing`);
      return;
    }
    log(`task ${id}: PR conflicts with ${target}; syncing it with ${target}`);
    try {
      const r = await syncTask(app, id, { manual: false });
      log(`task ${id}: ${r.outcome}${r.reason ? ` (${r.reason})` : ''}${r.push_error ? `; push failed: ${r.push_error}` : ''}`);
    } catch (err) {
      log(`task ${id}: could not sync with ${target}: ${errorMessage(err)}`);
    }
  }
}
