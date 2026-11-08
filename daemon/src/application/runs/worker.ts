// Runs one attempt of a claimed task: worktree, setup, claude, tests, then the task's next status.
import { SETUP_TIMEOUT_MS, TEST_TIMEOUT_MS, ensureDirs } from '../../config.ts';
import type { App } from '../ports/app.ts';
import type { Checkout } from '../ports/workspace.ts';
import { conflictReason, syncSummary } from '../../domain/landing/index.ts';
import { unfinishedSteps, unfinishedSummary } from '../../domain/work/index.ts';
import { type PromptPlan, buildPrompt, buildResumePrompt } from '../../domain/runs/index.ts';
import { latestReviewNote } from '../../domain/work/index.ts';
import {
  type Run,
  type WorkerResult,
  editsSinceCutOff,
  firstDenial,
  isEnvironmentBlock,
  parseStatus,
  resumableSession,
  resumeMaxTurns,
  runOutcome,
  setupFailedReason,
} from '../../domain/runs/index.ts';
import { hasPlanLink, otherPlanOwner } from '../../domain/work/index.ts';
import { type Task, leftoversMessage } from '../../domain/work/index.ts';
import { errorMessage } from '../../domain/shared/index.ts';
import { type OpenedRun, type TaskRunEnd, endTaskRun, openTaskRun, startTaskRun } from './claude-run.ts';
import type { Repo } from '../../domain/repos/index.ts';
import { syncBranch } from './sync.ts';
import { pauseRepo } from '../repos/pause.ts';
import { markSyncing } from '../work/checkout-locks.ts';
import { followedSteps, planForRun, takePlanFile } from '../work/plans.ts';
import { settle } from '../landing/settle.ts';
import { recordAnswers, reviewForRun } from '../landing/address.ts';

/** Run one attempt of a task that the scheduler has already claimed (status = running). */
export async function runTask(app: App, task: Task): Promise<WorkerResult> {
  ensureDirs();
  const repo = app.getRepo(task.repo_id);
  if (!repo) return finish(app, task, null, { outcome: 'failed', reason: `repo ${task.repo_id} not found` });

  let wt: Checkout;
  try {
    wt = await app.workspace.prepareCheckout(repo, task);
  } catch (err) {
    return finish(app, task, null, { outcome: 'failed', reason: `worktree: ${errorMessage(err)}` });
  }
  app.setCheckout(task.id, { branch: wt.branch, worktree: wt.path });

  const opened = openTaskRun(app, task, 'work');
  try {
    return await runOpened(app, task, repo, wt, opened);
  } catch (err) {
    // Whatever threw, the row ends failed (a no-op if it already ended) and the scheduler settles the task.
    await endTaskRun(app, opened, 'failed', errorMessage(err));
    throw err;
  }
}

/** The attempt's run once its row is open: everything up to the outcome, which `finish` records. */
async function runOpened(app: App, task: Task, repo: Repo, wt: Checkout, opened: OpenedRun): Promise<WorkerResult> {
  const { runId, log } = opened;
  const ws = app.workspace;
  const previousRuns = app.runsForTask(task.id).filter((r) => r.id !== runId);
  // A daemon restart cut the attempt's last run off: continue its claude session (with `prompt` as the fallback),
  // unless the prompt or plan was edited since, which the session never saw.
  let session = resumableSession(task, previousRuns);
  if (session) {
    const owner = otherPlanOwner(task);
    const edited = editsSinceCutOff(task, previousRuns, {
      own: app.eventsForTask(task.id),
      planOwner: owner === null ? [] : app.eventsForTask(owner),
    });
    if (edited.length) {
      app.runLog.event(log, {
        type: 'agentdeck_resume_skipped',
        session_id: session,
        text: `edited since: ${edited.join(', ')}; starting afresh`,
      });
      session = null;
    }
  }
  // A run a restart cut off never gave its plan file back, even if a person ended the task since and retried it: keep
  // what it got done before the file is written afresh. After a run that did give it back, this changes nothing.
  await giveBackPlan(app, task, wt.path, log);
  let plan: PromptPlan | null = null;
  try {
    plan = planForRun(app, task);
  } catch (err) {
    app.runLog.event(log, { type: 'agentdeck_error', text: `read plan: ${errorMessage(err)}` });
  }
  const review = await reviewForRun(app, task, repo);
  const prompt = buildPrompt(task, previousRuns, latestReviewNote(app.eventsForTask(task.id)), plan, review?.prompt ?? null);
  const resume = session ? { session, prompt: buildResumePrompt(task), maxTurns: resumeMaxTurns(task, previousRuns) } : undefined;

  // Install dependencies before the agent starts: it isn't allowed to install them itself.
  const setUp = async (): Promise<WorkerResult | null> => {
    if (!repo.setup_cmd) return null;
    const setup = await ws.runCommand(repo.setup_cmd, wt.path, SETUP_TIMEOUT_MS);
    app.runLog.event(log, { type: 'agentdeck_setup', cmd: repo.setup_cmd, passed: setup.passed, output: setup.output });
    if (setup.passed) return null;
    pauseRepo(app, repo, `setup failed on task #${task.id}`);
    return finish(app, task, opened, {
      outcome: 'blocked',
      reason: setupFailedReason(setup.output),
      environment: isEnvironmentBlock({ setupFailed: true }),
    });
  };
  const setupFailure = await setUp();
  if (setupFailure) return setupFailure;

  // Sync the branch with the latest base, on retries too, so the agent builds on current code.
  const synced = await markSyncing(app, task.id, () =>
    syncBranch(app, task, repo, wt.path, { allowResolve: repo.auto_resolve, runTests: false }),
  );
  app.runLog.event(log, { type: 'agentdeck_sync', ...synced });
  if (synced.kind === 'clean' || synced.kind === 'resolved') {
    app.recordSync(task.id, syncSummary(repo.base_branch, synced.kind, synced.kind === 'resolved' ? synced.files : []));
    // The merge may have changed what the setup installs.
    const resetupFailure = await setUp();
    if (resetupFailure) return resetupFailure;
  } else if (synced.kind === 'failed') {
    return finish(app, task, opened, { outcome: 'blocked', reason: conflictReason(repo.base_branch, synced.files, synced.reason) });
  } else if (synced.kind === 'rate_limited') {
    return finish(app, task, opened, { outcome: 'rate_limited', reason: synced.reason });
  } else if (synced.kind === 'cancelled') {
    return finish(app, task, opened, { outcome: 'cancelled' });
  }

  // The plan goes in the worktree's plan file, which git ignores, for the worker to set its steps' statuses in.
  try {
    await ws.writePlanFile(wt.path, plan?.html ?? null);
  } catch (err) {
    app.runLog.event(log, { type: 'agentdeck_error', text: `write plan file: ${errorMessage(err)}` });
  }

  // Written after setup: setup runs here in the daemon, outside the sandbox, so installs keep the network.
  let ran: TaskRunEnd;
  try {
    ran = await startTaskRun(app, task, { kind: 'work', repo, worktree: wt.path, prompt, opened, resume });
  } catch (err) {
    return finish(app, task, opened, { outcome: 'failed', reason: `settings:${errorMessage(err)}` });
  }
  const { result, end } = ran;
  const runFields: Partial<Run> = ran.fields;

  try {
    await ws.commit(wt.path, leftoversMessage(task));
  } catch (err) {
    app.runLog.event(log, { type: 'agentdeck_error', text: `commit leftovers: ${errorMessage(err)}` });
  }
  // Files the worker may not edit itself (under .claude/) and wrote to the edits folder instead: committed before the tests.
  try {
    const edits = await ws.applyProtectedEdits(wt.path);
    if (edits.applied.length || edits.refused.length) app.runLog.event(log, { type: 'agentdeck_protected_edits', ...edits });
  } catch (err) {
    app.runLog.event(log, { type: 'agentdeck_error', text: `apply protected edits: ${errorMessage(err)}` });
  }
  // What the worker did to the plan is stored, whatever the outcome.
  await giveBackPlan(app, task, wt.path, log);

  const denials = result?.permission_denials ?? [];
  runFields.denials = denials.length;
  let status: ReturnType<typeof parseStatus> | undefined;
  let testsPassed: boolean | null = null;
  let ahead: number | null = null;
  if (end.kind === 'finished') {
    status = parseStatus(end.result.result);
    // The answers to the review's comments are stored whatever the status; comments with none are named in the run's summary.
    if (review && runFields.result_text) runFields.result_text = recordAnswers(app, review.comments, runFields.result_text);
    if (!status.blocked && repo.test_cmd) {
      const tests = await ws.runCommand(repo.test_cmd, wt.path, TEST_TIMEOUT_MS);
      app.runLog.event(log, { type: 'agentdeck_tests', passed: tests.passed, output: tests.output });
      runFields.tests_passed = tests.passed;
      testsPassed = tests.passed;
    }
    if (!status.blocked && testsPassed !== false) ahead = await ws.commitsAhead(wt.path, repo.base_branch);
  }
  const { result: outcome, pause } = runOutcome({ end, status, testsPassed, commitsAhead: ahead, denials: denials.length });

  // A done run that left linked plan steps unfinished is a warning, not a change of outcome.
  if (outcome.outcome === 'done' && hasPlanLink(task)) {
    try {
      const left = unfinishedSteps(followedSteps(app, task) ?? []);
      if (left.length) app.recordPlanUnfinished(task.id, unfinishedSummary(left));
    } catch (err) {
      app.runLog.event(log, { type: 'agentdeck_error', text: `check plan steps: ${errorMessage(err)}` });
    }
  }

  if (pause) pauseRepo(app, repo, `permission refused on task #${task.id}: ${firstDenial(denials)}`);
  return finish(app, task, opened, outcome, runFields);
}

/** Store what a run left in the worktree's plan file (takePlanFile). A failure is logged, never fatal. */
async function giveBackPlan(app: App, task: Task, worktree: string, log: OpenedRun['log']): Promise<void> {
  try {
    await takePlanFile(app, task, worktree);
  } catch (err) {
    app.runLog.event(log, { type: 'agentdeck_error', text: `save plan file: ${errorMessage(err)}` });
  }
}

/** End the run (when there is one) and move the task to its next state (including retry). */
async function finish(
  app: App,
  task: Task,
  opened: OpenedRun | null,
  res: WorkerResult,
  runFields: Partial<Run> = {},
): Promise<WorkerResult> {
  if (opened) await endTaskRun(app, opened, res.outcome, res.reason, runFields);
  // If cancel was requested while the run was ending, the lifecycle makes every outcome end 'cancelled'.
  const reason = { reason: res.reason ?? null };
  switch (res.outcome) {
    case 'done':
    case 'cancelled':
      await settle(app, task.id, { type: 'finish', outcome: res.outcome }, reason);
      break;
    case 'blocked':
      // The environment, not the task, is to blame: the attempt is given back.
      await settle(
        app,
        task.id,
        { type: 'finish', outcome: 'blocked', environment: res.environment === true },
        { ...reason, needs: res.needs ?? null },
      );
      break;
    case 'rate_limited':
      // Not the task's fault: give the attempt back and requeue.
      await settle(app, task.id, { type: 'rate_limited' });
      break;
    case 'failed':
      await settle(app, task.id, { type: 'finish', outcome: 'failed', retry: task.attempts < task.max_attempts }, reason);
      break;
  }
  return res;
}
