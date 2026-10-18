// Runs one attempt of a claimed task: worktree, setup, claude, tests, then the task's next status.
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { runClaude } from '../adapters/claude.ts';
import { commitLeftovers, commitsAhead, ensureWorktree } from '../adapters/git.ts';
import { closeLog, writeEvent } from '../adapters/run-log.ts';
import { lastLine, runCommand } from '../adapters/shell.ts';
import { LOG_DIR, SETUP_TIMEOUT_MS, TEST_TIMEOUT_MS, ensureDirs } from '../config.ts';
import type { Db } from '../db/index.ts';
import { buildPrompt, claudeArgs } from '../domain/run/prompt.ts';
import { type Run, type WorkerResult, firstDenial, parseStatus } from '../domain/run/run.ts';
import type { Task } from '../domain/task/task.ts';
import { warnStuckDependents } from './dependencies.ts';
import { notifyLater } from './notifications.ts';
import { pauseRepo } from './pause.ts';
import { openPullRequest } from './pull-requests.ts';
import { effectiveTools } from './tools.ts';

/** Run one attempt of a task that the scheduler has already claimed (status = running). */
export async function runTask(db: Db, task: Task): Promise<WorkerResult> {
  ensureDirs();
  const repo = db.getRepo(task.repo_id);
  if (!repo) return finish(db, task, null, { outcome: 'failed', reason: `repo ${task.repo_id} not found` });

  let wt: { branch: string; path: string };
  try {
    wt = await ensureWorktree(repo, task);
  } catch (err) {
    return finish(db, task, null, { outcome: 'failed', reason: `worktree: ${(err as Error).message}` });
  }
  db.updateTask(task.id, { branch: wt.branch, worktree: wt.path });

  const logPath = join(LOG_DIR, `task-${task.id}-attempt-${task.attempts}.jsonl`);
  const log = createWriteStream(logPath, { flags: 'a' });
  const runId = db.startRun(task.id, task.attempts, logPath);
  const prompt = buildPrompt(
    task,
    db.runsForTask(task.id).filter((r) => r.id !== runId),
  );

  // Install dependencies before the agent starts: it isn't allowed to install them itself.
  if (repo.setup_cmd) {
    const setup = await runCommand(repo.setup_cmd, wt.path, SETUP_TIMEOUT_MS);
    writeEvent(log, { type: 'agentdeck_setup', cmd: repo.setup_cmd, passed: setup.passed, output: setup.output });
    if (!setup.passed) {
      await closeLog(log);
      pauseRepo(db, repo, `setup failed on task #${task.id}`);
      return finish(db, task, runId, { outcome: 'blocked', reason: `setup failed: ${lastLine(setup.output)}` });
    }
  }

  const { result, exitCode, rateLimitedUntil, cancelled } = await runClaude({
    args: claudeArgs(task, effectiveTools(repo, wt.path), prompt),
    cwd: wt.path,
    log,
    env: { AGENTDECK_TASK_ID: String(task.id) },
    shouldCancel: () => db.getTask(task.id)?.status === 'cancel_requested',
    onSpawn: (pid) => db.setRunPid(runId, pid),
    onUsage: (w) => db.recordUsageWindow(w.window, w.utilization, w.resets_at, w.status),
  });

  const usage = result?.usage ?? {};
  const runFields: Partial<Run> = {
    exit_code: exitCode,
    session_id: result?.session_id ?? null,
    num_turns: result?.num_turns ?? null,
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_read_tokens: usage.cache_read_input_tokens ?? 0,
    cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
    cost_usd: result?.total_cost_usd ?? 0,
    result_text: result?.result ?? null,
  };

  try {
    await commitLeftovers(wt.path, `agentdeck: uncommitted work from task ${task.id}\n\n${task.title}`);
  } catch (err) {
    writeEvent(log, { type: 'agentdeck_error', text: `commit leftovers: ${(err as Error).message}` });
  }

  let outcome: WorkerResult;
  if (cancelled) {
    outcome = { outcome: 'cancelled' };
  } else if (rateLimitedUntil) {
    const until = rateLimitedUntil;
    db.setSetting('rate_limited_until', String(until));
    outcome = { outcome: 'rate_limited', reason: `rate limited until ${new Date(until * 1000).toISOString()}` };
  } else if (!result || result.is_error || exitCode !== 0) {
    outcome = { outcome: 'failed', reason: result?.subtype ?? `claude exited with code ${exitCode}` };
  } else {
    const status = parseStatus(result.result);
    if (status.blocked) {
      outcome = { outcome: 'blocked', reason: status.reason ?? 'agent reported blocked' };
    } else if (repo.test_cmd) {
      const tests = await runCommand(repo.test_cmd, wt.path, TEST_TIMEOUT_MS);
      writeEvent(log, { type: 'agentdeck_tests', passed: tests.passed, output: tests.output });
      runFields.tests_passed = tests.passed ? 1 : 0;
      outcome = tests.passed ? { outcome: 'done' } : { outcome: 'failed', reason: 'tests failed' };
    } else {
      outcome = { outcome: 'done' };
    }
    if (outcome.outcome === 'done' && (await commitsAhead(wt.path, repo.base_branch)) === 0) {
      outcome = { outcome: 'blocked', reason: 'agent finished without changing anything' };
    }
  }

  await closeLog(log);
  // Refused tool uses mean the repo's tool rules don't fit its work: every further task would hit the same wall.
  const denials = result?.permission_denials ?? [];
  runFields.denials = denials.length;
  if (denials.length && (outcome.outcome === 'blocked' || outcome.outcome === 'failed')) {
    pauseRepo(db, repo, `permission refused on task #${task.id}: ${firstDenial(denials)}`);
  }
  return finish(db, task, runId, outcome, runFields);
}

/** Record the run and move the task to its next state (including retry). */
async function finish(db: Db, task: Task, runId: number | null, res: WorkerResult, runFields: Partial<Run> = {}): Promise<WorkerResult> {
  if (runId !== null) {
    db.finishRun(runId, {
      ...runFields,
      outcome: res.outcome,
      ...(res.reason && !runFields.result_text ? { result_text: res.reason } : {}),
    });
  }
  // If cancel was requested while the run was ending, the lifecycle makes every outcome end 'cancelled'.
  const reason = { reason: res.reason ?? null };
  switch (res.outcome) {
    case 'done':
    case 'blocked':
    case 'cancelled':
      db.applyEvent(task.id, { type: 'finish', outcome: res.outcome }, reason);
      break;
    case 'rate_limited':
      // Not the task's fault: give the attempt back and requeue.
      db.applyEvent(task.id, { type: 'rate_limited' });
      break;
    case 'failed':
      db.applyEvent(task.id, { type: 'finish', outcome: 'failed', retry: task.attempts < task.max_attempts }, reason);
      break;
  }

  // Tell a human about final outcomes (a failure that will be retried isn't final).
  const final = db.getTask(task.id)!;
  if (final.status === 'done' || final.status === 'blocked' || final.status === 'failed') {
    const repo = db.getRepo(task.repo_id)?.name ?? '';
    // The daemon opens the PR (agents cannot push). Whatever happens, the task stays done.
    const pr = final.status === 'done' ? await openPullRequest(db, final) : {};
    let body =
      final.status === 'done'
        ? `Ready to review on ${final.branch ?? 'its branch'}${repo ? ` in ${repo}` : ''}.`
        : `${final.blocked_reason ?? final.status}${repo ? ` (${repo})` : ''}`;
    if (pr.url) body = `${body} PR: ${pr.url}`;
    if (pr.error) body = `${body} Could not open a PR: ${pr.error}`;
    notifyLater(db, { kind: final.status, title: `#${task.id} ${final.status}: ${task.title}`, body, task_id: task.id });
  }
  warnStuckDependents(db, task.id);
  return res;
}
