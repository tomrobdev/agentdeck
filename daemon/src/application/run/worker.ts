// Runs one attempt of a claimed task: worktree, setup, claude, tests, then the task's next status.
import { commitLeftovers, commitsAhead, ensureWorktree } from '../../adapters/git.ts';
import { writePlanFile } from '../../adapters/plan-file.ts';
import { closeLog, writeEvent } from '../../adapters/run-log.ts';
import { runCommand } from '../../adapters/shell.ts';
import { SETUP_TIMEOUT_MS, TEST_TIMEOUT_MS, ensureDirs } from '../../config.ts';
import type { Db } from '../../db/index.ts';
import { conflictReason, syncSummary } from '../../domain/branch/sync.ts';
import { lastLine } from '../../domain/text.ts';
import { unfinishedSteps, unfinishedSummary } from '../../domain/plan/plan.ts';
import { type PromptPlan, buildPrompt, buildResumePrompt } from '../../domain/run/prompt.ts';
import { latestReviewNote } from '../../domain/task/history.ts';
import {
  type Run,
  type WorkerResult,
  editsSinceCutOff,
  firstDenial,
  isEnvironmentBlock,
  parseStatus,
  resumableSession,
  resumeMaxTurns,
} from '../../domain/run/run.ts';
import { type Task, leftoversMessage } from '../../domain/task/task.ts';
import { type TaskRunEnd, openTaskRun, startTaskRun } from './claude-run.ts';
import { syncBranch } from '../sync.ts';
import { pauseRepo } from '../scheduler/pause.ts';
import { followedSteps, planForRun, takePlanFile } from '../plans.ts';
import { settle } from '../task/settle.ts';
import { recordAnswers, reviewForRun } from '../review/address.ts';

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
  db.setCheckout(task.id, { branch: wt.branch, worktree: wt.path });

  const opened = openTaskRun(db, task, 'work');
  const { runId, log } = opened;
  const previousRuns = db.runsForTask(task.id).filter((r) => r.id !== runId);
  // A daemon restart cut the attempt's last run off: continue its claude session (with `prompt` as the fallback),
  // unless the prompt or plan was edited since, which the session never saw.
  let session = resumableSession(task, previousRuns);
  if (session) {
    const owner = task.plan_task !== null && task.plan_task !== task.id ? task.plan_task : null;
    const edited = editsSinceCutOff(task, previousRuns, {
      own: db.eventsForTask(task.id),
      planOwner: owner === null ? [] : db.eventsForTask(owner),
    });
    if (edited.length) {
      writeEvent(log, {
        type: 'agentdeck_resume_skipped',
        session_id: session,
        text: `edited since: ${edited.join(', ')}; starting afresh`,
      });
      session = null;
    }
  }
  // A run a restart cut off never gave its plan file back, even if a person ended the task since and retried it: keep
  // what it got done before the file is written afresh. After a run that did give it back, this changes nothing.
  await giveBackPlan(db, task, wt.path, log);
  let plan: PromptPlan | null = null;
  try {
    plan = planForRun(db, task);
  } catch (err) {
    writeEvent(log, { type: 'agentdeck_error', text: `read plan: ${(err as Error).message}` });
  }
  const review = await reviewForRun(db, task, repo);
  const prompt = buildPrompt(task, previousRuns, latestReviewNote(db.eventsForTask(task.id)), plan, review?.prompt ?? null);
  const resume = session ? { session, prompt: buildResumePrompt(task), maxTurns: resumeMaxTurns(task, previousRuns) } : undefined;

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

  // Sync the branch with the latest base, on retries too, so the agent builds on current code.
  const synced = await syncBranch(db, task, repo, wt.path, { allowResolve: repo.auto_resolve === 1, runTests: false });
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

  // The plan goes in the worktree's plan file, which git ignores, for the worker to set its steps' statuses in.
  try {
    await writePlanFile(wt.path, plan?.html ?? null);
  } catch (err) {
    writeEvent(log, { type: 'agentdeck_error', text: `write plan file: ${(err as Error).message}` });
  }

  // Written after setup: setup runs here in the daemon, outside the sandbox, so installs keep the network.
  let ran: TaskRunEnd;
  try {
    ran = await startTaskRun(db, task, { kind: 'work', repo, worktree: wt.path, prompt, opened, resume });
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
  // What the worker did to the plan is stored, whatever the outcome.
  await giveBackPlan(db, task, wt.path, log);

  let outcome: WorkerResult;
  if (end.kind === 'cancelled') {
    outcome = { outcome: 'cancelled' };
  } else if (end.kind === 'rate_limited') {
    outcome = { outcome: 'rate_limited', reason: end.reason };
  } else if (end.kind === 'failed') {
    outcome = { outcome: 'failed', reason: end.reason };
  } else {
    const status = parseStatus(end.result.result);
    // The answers to the review's comments are stored whatever the status; comments with none are named in the run's summary.
    if (review && runFields.result_text) runFields.result_text = recordAnswers(db, review.comments, runFields.result_text);
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
  if (outcome.outcome === 'done' && task.plan_task !== null) {
    try {
      const left = unfinishedSteps(followedSteps(db, task) ?? []);
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

/** Store what a run left in the worktree's plan file (takePlanFile). A failure is logged, never fatal. */
async function giveBackPlan(db: Db, task: Task, worktree: string, log: Parameters<typeof writeEvent>[0]): Promise<void> {
  try {
    await takePlanFile(db, task, worktree);
  } catch (err) {
    writeEvent(log, { type: 'agentdeck_error', text: `save plan file: ${(err as Error).message}` });
  }
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
      await settle(db, task.id, { type: 'finish', outcome: res.outcome }, reason);
      break;
    case 'blocked':
      // The environment, not the task, is to blame: the attempt is given back.
      await settle(
        db,
        task.id,
        { type: 'finish', outcome: 'blocked', environment: res.environment === true },
        { ...reason, needs: res.needs ? JSON.stringify(res.needs) : null },
      );
      break;
    case 'rate_limited':
      // Not the task's fault: give the attempt back and requeue.
      await settle(db, task.id, { type: 'rate_limited' });
      break;
    case 'failed':
      await settle(db, task.id, { type: 'finish', outcome: 'failed', retry: task.attempts < task.max_attempts }, reason);
      break;
  }
  return res;
}
