// Runs one attempt of a claimed task: worktree, setup, claude, tests, then the task's next status.
import { SETUP_TIMEOUT_MS, TEST_TIMEOUT_MS, ensureDirs } from '#src/config.ts';
import type { App } from '#application/ports/app.ts';
import type { Checkout } from '#application/ports/workspace.ts';
import { conflictReason, syncSummary } from '#domain/runs/index.ts';
import { unfinishedSteps, unfinishedSummary } from '#domain/work/index.ts';
import {
  CODE_COMMENTS_MAX_TURNS,
  type PromptPlan,
  type SummaryContext,
  buildCodeCommentsPrompt,
  buildPrompt,
  buildResumePrompt,
  withTurnUsage,
  workerSystemPrompt,
} from '#domain/runs/index.ts';
import { codeCommentFields, measureCodeComments } from '#application/runs/code-comments.ts';
import { latestReviewNote } from '#domain/work/index.ts';
import {
  type Run,
  type WorkerResult,
  editsSinceCutOff,
  escalationSince,
  firstDenial,
  isEnvironmentBlock,
  parseStatus,
  resumableSession,
  resumeMaxTurns,
  runOutcome,
  setupFailedReason,
} from '#domain/runs/index.ts';
import { hasPlanLink, otherPlanOwner } from '#domain/work/index.ts';
import { type Task, attemptsLeft, leftoversMessage } from '#domain/work/index.ts';
import { errorMessage } from '#domain/shared/index.ts';
import { type OpenedRun, type TaskRunEnd, endTaskRun, openTaskRun, startTaskRun } from '#application/runs/claude-run.ts';
import type { Repo } from '#domain/repos/index.ts';
import { syncBranch } from '#application/runs/sync.ts';
import { pauseRepo } from '#application/repos/pause.ts';
import { markSyncing } from '#application/work/checkout-locks.ts';
import { followedSteps, planForRun, takePlanFile } from '#application/work/plans.ts';
import { settle } from '#application/landing/settle.ts';
import { recordAnswers, reviewForRun } from '#application/landing/review/address.ts';
import { escalateAfter } from '#application/work/escalate.ts';

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
    await endTaskRun(app, opened, 'failed', errorMessage(err), {}, summaryContext(app, task));
    throw err;
  }
}

async function runOpened(app: App, task: Task, repo: Repo, wt: Checkout, opened: OpenedRun): Promise<WorkerResult> {
  const { runId, log } = opened;
  const ws = app.workspace;
  const previousRuns = app.runsForTask(task.id).filter((r) => r.id !== runId);
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
  await giveBackPlan(app, task, wt.path, log);
  let plan: PromptPlan | null = null;
  try {
    plan = planForRun(app, task);
  } catch (err) {
    app.runLog.event(log, { type: 'agentdeck_error', text: `read plan: ${errorMessage(err)}` });
  }
  const review = await reviewForRun(app, task, repo);
  const events = app.eventsForTask(task.id);
  const note = latestReviewNote(events);
  const prompt = buildPrompt(task, previousRuns, note, plan, review?.prompt ?? null, escalationSince(events, previousRuns));
  const resume = session ? { session, prompt: buildResumePrompt(task), maxTurns: resumeMaxTurns(task, previousRuns) } : undefined;

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

  const synced = await markSyncing(app, task.id, () =>
    syncBranch(app, task, repo, wt.path, { allowResolve: repo.auto_resolve, runTests: false }),
  );
  app.runLog.event(log, { type: 'agentdeck_sync', ...synced });
  if (synced.kind === 'clean' || synced.kind === 'resolved') {
    app.recordSync(task.id, syncSummary(repo.base_branch, synced.kind, synced.kind === 'resolved' ? synced.files : []));
    const resetupFailure = await setUp();
    if (resetupFailure) return resetupFailure;
  } else if (synced.kind === 'failed') {
    return finish(app, task, opened, { outcome: 'blocked', reason: conflictReason(repo.base_branch, synced.files, synced.reason) });
  } else if (synced.kind === 'rate_limited') {
    return finish(app, task, opened, { outcome: 'rate_limited', reason: synced.reason });
  } else if (synced.kind === 'cancelled') {
    return finish(app, task, opened, { outcome: 'cancelled' });
  }

  try {
    await ws.writePlanFile(wt.path, plan?.html ?? null);
  } catch (err) {
    app.runLog.event(log, { type: 'agentdeck_error', text: `write plan file: ${errorMessage(err)}` });
  }

  const systemPrompt = workerSystemPrompt(repo.test_cmd, repo);
  let ran: TaskRunEnd;
  try {
    ran = await startTaskRun(app, task, { kind: 'work', repo, worktree: wt.path, prompt, note, opened, resume, systemPrompt });
  } catch (err) {
    return finish(app, task, opened, { outcome: 'failed', reason: `settings:${errorMessage(err)}` });
  }
  const { result, end } = ran;
  let runFields: Partial<Run> = ran.fields;

  const afterClaude = async (): Promise<void> => {
    try {
      await ws.commit(wt.path, leftoversMessage(task));
    } catch (err) {
      app.runLog.event(log, { type: 'agentdeck_error', text: `commit leftovers: ${errorMessage(err)}` });
    }
    try {
      const edits = await ws.applyProtectedEdits(wt.path);
      if (edits.applied.length || edits.refused.length) app.runLog.event(log, { type: 'agentdeck_protected_edits', ...edits });
    } catch (err) {
      app.runLog.event(log, { type: 'agentdeck_error', text: `apply protected edits: ${errorMessage(err)}` });
    }
    await giveBackPlan(app, task, wt.path, log);
  };
  const runTests = async (): Promise<boolean | null> => {
    if (!repo.test_cmd) return null;
    const tests = await ws.runCommand(repo.test_cmd, wt.path, TEST_TIMEOUT_MS);
    app.runLog.event(log, { type: 'agentdeck_tests', passed: tests.passed, output: tests.output });
    runFields.tests_passed = tests.passed;
    return tests.passed;
  };
  await afterClaude();

  const denials = result?.permission_denials ?? [];
  runFields.denials = denials.length;
  let status: ReturnType<typeof parseStatus> | undefined;
  let testsPassed: boolean | null = null;
  let ahead: number | null = null;
  if (end.kind === 'finished') {
    status = parseStatus(end.result.result);
    if (review && runFields.result_text) runFields.result_text = recordAnswers(app, review.comments, runFields.result_text);
    if (!status.blocked) testsPassed = await runTests();
    if (!status.blocked && testsPassed !== false) ahead = await ws.commitsAhead(wt.path, repo.base_branch);
  }
  let { result: outcome, pause } = runOutcome({ end, status, testsPassed, commitsAhead: ahead, denials: denials.length });

  const measured = outcome.outcome === 'done' ? await measureCodeComments(app, repo, wt.path, log) : null;
  if (measured) Object.assign(runFields, codeCommentFields(measured.count));
  if (measured?.over && runFields.session_id) {
    const turnPrompt = buildCodeCommentsPrompt(measured.count, repo, repo.test_cmd);
    const maxTurns = Math.min(CODE_COMMENTS_MAX_TURNS, task.max_turns);
    const turn = await startTaskRun(app, task, {
      kind: 'work',
      repo,
      worktree: wt.path,
      prompt: turnPrompt,
      opened,
      resume: { session: runFields.session_id, prompt: turnPrompt, maxTurns },
      systemPrompt,
    });
    runFields = withTurnUsage(runFields, turn.fields);
    if (turn.end.kind === 'cancelled') return finish(app, task, opened, { outcome: 'cancelled' }, runFields);
    await afterClaude();
    testsPassed = await runTests();
    const again = await measureCodeComments(app, repo, wt.path, log);
    if (again) Object.assign(runFields, codeCommentFields(again.count));
    ({ result: outcome, pause } = runOutcome({ end, status, testsPassed, commitsAhead: ahead, denials: denials.length }));
  }

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

async function giveBackPlan(app: App, task: Task, worktree: string, log: OpenedRun['log']): Promise<void> {
  try {
    await takePlanFile(app, task, worktree);
  } catch (err) {
    app.runLog.event(log, { type: 'agentdeck_error', text: `save plan file: ${errorMessage(err)}` });
  }
}

function summaryContext(app: App, task: Task): SummaryContext {
  return { testCmd: app.getRepo(task.repo_id)?.test_cmd ?? null, maxTurns: task.max_turns };
}

async function finish(
  app: App,
  task: Task,
  opened: OpenedRun | null,
  res: WorkerResult,
  runFields: Partial<Run> = {},
): Promise<WorkerResult> {
  if (opened) await endTaskRun(app, opened, res.outcome, res.reason, runFields, summaryContext(app, task));
  const reason = { reason: res.reason ?? null };
  switch (res.outcome) {
    case 'done':
    case 'cancelled':
      await settle(app, task.id, { type: 'finish', outcome: res.outcome }, reason);
      break;
    case 'blocked':
      await settle(
        app,
        task.id,
        { type: 'finish', outcome: 'blocked', environment: res.environment === true },
        { ...reason, needs: res.needs ?? null },
      );
      break;
    case 'rate_limited':
      await settle(app, task.id, { type: 'rate_limited' });
      break;
    case 'failed': {
      const run = attemptsLeft(task) && opened ? app.runsForTask(task.id).find((r) => r.id === opened.runId) : undefined;
      if (run) escalateAfter(app, task, run, { reason: res.reason ?? null, needs: res.needs ?? null }, ['running']);
      await settle(app, task.id, { type: 'finish', outcome: 'failed' }, reason);
      break;
    }
  }
  return res;
}
