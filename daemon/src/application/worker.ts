// Runs one attempt of a claimed task: worktree, setup, claude, tests, then the task's next status.
import { commitLeftovers, commitsAhead, ensureWorktree } from '../adapters/git.ts';
import { closeLog, writeEvent } from '../adapters/run-log.ts';
import { lastLine, runCommand } from '../adapters/shell.ts';
import { SETUP_TIMEOUT_MS, TEST_TIMEOUT_MS, ensureDirs } from '../config.ts';
import type { Db } from '../db/index.ts';
import { conflictReason, syncSummary } from '../domain/pull-request/conflict.ts';
import { linkedSteps, unfinishedSteps, unfinishedSummary } from '../domain/plan/plan.ts';
import { type PromptPlan, buildPrompt } from '../domain/run/prompt.ts';
import { latestReviewNote } from '../domain/task/history.ts';
import { type Run, type WorkerResult, firstDenial, isEnvironmentBlock, parseStatus } from '../domain/run/run.ts';
import { type Task, leftoversMessage, planStepIds } from '../domain/task/task.ts';
import { type TaskRunEnd, openTaskRun, startTaskRun } from './claude-run.ts';
import { bringInBase } from './conflicts.ts';
import { warnStuckDependents } from './dependencies.ts';
import { notifyLater } from './notifications.ts';
import { pauseRepo } from './pause.ts';
import { collectPlans, planForRun } from './plans.ts';
import { openPullRequest } from './pull-requests.ts';

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

  const opened = openTaskRun(db, task, 'work');
  const { runId, log } = opened;
  let plan: PromptPlan | null = null;
  try {
    plan = await planForRun(db, task);
  } catch (err) {
    writeEvent(log, { type: 'agentdeck_error', text: `read plan: ${(err as Error).message}` });
  }
  const prompt = buildPrompt(
    task,
    db.runsForTask(task.id).filter((r) => r.id !== runId),
    latestReviewNote(db.eventsForTask(task.id)),
    plan,
  );

  // Install dependencies before the agent starts: it isn't allowed to install them itself.
  const setUp = async (): Promise<WorkerResult | null> => {
    if (!repo.setup_cmd) return null;
    const setup = await runCommand(repo.setup_cmd, wt.path, SETUP_TIMEOUT_MS);
    writeEvent(log, { type: 'agentdeck_setup', cmd: repo.setup_cmd, passed: setup.passed, output: setup.output });
    if (setup.passed) return null;
    await closeLog(log);
    pauseRepo(db, repo, `setup failed on task #${task.id}`);
    return finish(db, task, runId, {
      outcome: 'blocked',
      reason: `setup failed: ${lastLine(setup.output)}`,
      environment: isEnvironmentBlock({ setupFailed: true }),
    });
  };
  const setupFailure = await setUp();
  if (setupFailure) return setupFailure;

  // Bring the latest base into the branch, on retries too, so the agent builds on current code.
  const synced = await bringInBase(db, task, repo, wt.path, { allowResolve: repo.auto_resolve === 1, runTests: false });
  writeEvent(log, { type: 'agentdeck_sync', ...synced });
  if (synced.kind === 'clean' || synced.kind === 'resolved') {
    db.recordSync(task.id, syncSummary(repo.base_branch, synced.kind, synced.kind === 'resolved' ? synced.files : []));
    // The merge may have changed what the setup installs.
    const resetupFailure = await setUp();
    if (resetupFailure) return resetupFailure;
  } else if (synced.kind === 'failed') {
    await closeLog(log);
    return finish(db, task, runId, { outcome: 'blocked', reason: conflictReason(repo.base_branch, synced.files, synced.reason) });
  } else if (synced.kind === 'rate_limited') {
    await closeLog(log);
    return finish(db, task, runId, { outcome: 'rate_limited', reason: synced.reason });
  } else if (synced.kind === 'cancelled') {
    await closeLog(log);
    return finish(db, task, runId, { outcome: 'cancelled' });
  }

  // Written after setup: setup runs here in the daemon, outside the sandbox, so installs keep the network.
  let ran: TaskRunEnd;
  try {
    ran = await startTaskRun(db, task, { kind: 'work', repo, worktree: wt.path, prompt, opened });
  } catch (err) {
    await closeLog(log);
    return finish(db, task, runId, { outcome: 'failed', reason: `settings: ${(err as Error).message}` });
  }
  const { result, end } = ran;
  const runFields: Partial<Run> = ran.fields;

  try {
    await commitLeftovers(wt.path, leftoversMessage(task));
  } catch (err) {
    writeEvent(log, { type: 'agentdeck_error', text: `commit leftovers: ${(err as Error).message}` });
  }
  // Plans the agent wrote on its branch are attached to the task, whatever the outcome.
  try {
    await collectPlans(db, task.id);
  } catch (err) {
    writeEvent(log, { type: 'agentdeck_error', text: `collect plans: ${(err as Error).message}` });
  }

  let outcome: WorkerResult;
  if (end.kind === 'cancelled') {
    outcome = { outcome: 'cancelled' };
  } else if (end.kind === 'rate_limited') {
    outcome = { outcome: 'rate_limited', reason: end.reason };
  } else if (end.kind === 'failed') {
    outcome = { outcome: 'failed', reason: end.reason };
  } else {
    const status = parseStatus(end.result.result);
    if (status.blocked) {
      outcome = { outcome: 'blocked', reason: status.reason ?? 'agent reported blocked', ...(status.needs ? { needs: status.needs } : {}) };
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

  // A done run that left linked plan steps unfinished is a warning, not a change of outcome.
  if (outcome.outcome === 'done' && task.plan_path) {
    try {
      const html = (await planForRun(db, task))?.html;
      const left = unfinishedSteps((html && linkedSteps(html, planStepIds(task))) || []);
      if (left.length) db.recordPlanUnfinished(task.id, unfinishedSummary(left));
    } catch (err) {
      writeEvent(log, { type: 'agentdeck_error', text: `check plan steps: ${(err as Error).message}` });
    }
  }

  await closeLog(log);
  // Refused tool uses mean the repo's tool rules don't fit its work: every further task would hit the same wall.
  // Not when the agent finished and only the test command failed: the refusals didn't stop it.
  const denials = result?.permission_denials ?? [];
  runFields.denials = denials.length;
  const testsFailed = runFields.tests_passed === 0;
  if (outcome.outcome === 'blocked' && isEnvironmentBlock({ needs: outcome.needs, denials: denials.length })) outcome.environment = true;
  if (denials.length && !testsFailed && (outcome.outcome === 'blocked' || outcome.outcome === 'failed')) {
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
    case 'cancelled':
      db.applyEvent(task.id, { type: 'finish', outcome: res.outcome }, reason);
      break;
    case 'blocked':
      // The environment, not the task, is to blame: the attempt is given back.
      db.applyEvent(
        task.id,
        { type: 'finish', outcome: 'blocked', environment: res.environment === true },
        { ...reason, needs: res.needs ? JSON.stringify(res.needs) : null },
      );
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
