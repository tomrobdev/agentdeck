// The unblock run of a blocked task: claude reads why the task stopped, then the daemon queues it again with the run's note or leaves it blocked with the run's question.
import type { App } from '#application/ports/app.ts';
import type { TaskId } from '#domain/shared/index.ts';
import type { PromptPlan } from '#domain/runs/index.ts';
import {
  UNBLOCK_MAX_TURNS,
  type UnblockDecision,
  buildUnblockPrompt,
  parseUnblock,
  unblockDecision,
  unblockSystemPrompt,
  unblockable,
} from '#domain/runs/index.ts';
import { latestReviewNote } from '#domain/work/index.ts';
import { type BlockedTask, leftoversMessage } from '#domain/work/index.ts';
import { errorMessage } from '#domain/shared/index.ts';
import { type OpenedRun, endTaskRun, openTaskRun, startTaskRun } from '#application/runs/claude-run.ts';
import { planForRun } from '#application/work/plans.ts';
import { settle } from '#application/landing/settle.ts';

export interface UnblockReport {
  outcome: 'retried' | 'asked' | 'stale' | 'failed' | 'rate_limited' | 'cancelled';
  reason?: string;
}

export function unblockableTasks(app: App): BlockedTask[] {
  return app.unblockCandidates().filter((t) => {
    const repo = app.getRepo(t.repo_id);
    return repo !== undefined && unblockable(t, app.runsForTask(t.id), repo);
  });
}

export function nextUnblockable(app: App): BlockedTask | undefined {
  return unblockableTasks(app)[0];
}

export async function runUnblock(app: App, task: BlockedTask): Promise<UnblockReport> {
  const opened = openTaskRun(app, task, 'unblock');
  try {
    return await runOpened(app, task, opened);
  } catch (err) {
    const reason = errorMessage(err);
    await endTaskRun(app, opened, 'failed', reason);
    return { outcome: 'failed', reason };
  }
}

async function runOpened(app: App, task: BlockedTask, opened: OpenedRun): Promise<UnblockReport> {
  const { log } = opened;
  const repo = app.getRepo(task.repo_id);
  if (!repo) throw new Error(`repo ${task.repo_id} not found`);
  const wt = await app.workspace.prepareCheckout(repo, task);
  if (wt.path !== task.checkout?.worktree) app.setCheckout(task.id, { branch: wt.branch, worktree: wt.path });

  let plan: PromptPlan | null = null;
  try {
    plan = planForRun(app, task);
  } catch (err) {
    app.runLog.event(log, { type: 'agentdeck_error', text: `read plan: ${errorMessage(err)}` });
  }
  const lastWork = app.runsForTask(task.id).findLast((r) => r.kind === 'work');
  const note = latestReviewNote(app.eventsForTask(task.id));
  const prompt = buildUnblockPrompt(task, { plan, lastMessage: lastWork?.result_text ?? null, reviewNote: note });

  const ran = await startTaskRun(app, task, {
    note,
    kind: 'unblock',
    repo,
    worktree: wt.path,
    prompt,
    opened,
    maxTurns: Math.min(UNBLOCK_MAX_TURNS, task.max_turns),
    systemPrompt: unblockSystemPrompt(),
  });
  try {
    await app.workspace.commit(wt.path, leftoversMessage(task));
  } catch (err) {
    app.runLog.event(log, { type: 'agentdeck_error', text: `commit leftovers: ${errorMessage(err)}` });
  }

  const { end, fields } = ran;
  if (end.kind === 'cancelled') {
    await endTaskRun(app, opened, 'cancelled', 'the task is no longer blocked', fields);
    return { outcome: 'cancelled' };
  }
  if (end.kind === 'rate_limited' || end.kind === 'failed' || end.kind === 'timed_out') {
    const outcome = end.kind === 'rate_limited' ? end.kind : 'failed';
    await endTaskRun(app, opened, outcome, end.reason, fields);
    return { outcome, reason: end.reason };
  }
  const decision = unblockDecision(parseUnblock(end.result.result), app.getTask(task.id) ?? task);
  app.runLog.event(log, {
    type: 'agentdeck_unblock',
    text: 'retry' in decision ? `Retried with a note: ${decision.retry}` : `Asked a question: ${decision.ask.question}`,
  });
  await endTaskRun(app, opened, 'retry' in decision ? 'done' : 'blocked', undefined, fields);
  return settleUnblock(app, task.id, decision);
}

async function settleUnblock(app: App, id: TaskId, decision: UnblockDecision): Promise<UnblockReport> {
  if ('retry' in decision) {
    const task = await settle(app, id, { type: 'unblock_retry' }, { reason: decision.retry });
    return task ? { outcome: 'retried', reason: decision.retry } : { outcome: 'stale' };
  }
  const asked = app.recordQuestion(id, decision.ask, decision.ask.question);
  return asked ? { outcome: 'asked', reason: decision.ask.question } : { outcome: 'stale' };
}
