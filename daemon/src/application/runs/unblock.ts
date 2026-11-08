// The unblock run of a blocked task: claude reads why the task stopped, then the daemon queues it again with the run's
// note or leaves it blocked with the run's question. It takes a slot and uses no attempt (domain/runs/unblock.ts).
import { writeEvent } from '../../adapters/run-log.ts';
import type { App } from '../ports/app.ts';
import type { TaskId } from '../../domain/shared/index.ts';
import type { PromptPlan } from '../../domain/runs/index.ts';
import {
  UNBLOCK_MAX_TURNS,
  type UnblockDecision,
  buildUnblockPrompt,
  parseUnblock,
  unblockDecision,
  unblockSystemPrompt,
  unblockable,
} from '../../domain/runs/index.ts';
import { latestReviewNote } from '../../domain/work/index.ts';
import { type BlockedTask, leftoversMessage } from '../../domain/work/index.ts';
import { errorMessage } from '../../domain/shared/index.ts';
import { type OpenedRun, endTaskRun, openTaskRun, startTaskRun } from './claude-run.ts';
import { planForRun } from '../work/plans.ts';
import { settle } from '../landing/settle.ts';

/** What an unblock run came to. `stale`: the task stopped being blocked while it ran, so nothing was changed. */
export interface UnblockReport {
  outcome: 'retried' | 'asked' | 'stale' | 'failed' | 'rate_limited' | 'cancelled';
  reason?: string;
}

/** The blocked task an unblock run should start for next (`unblockable`), or undefined when none may. */
export function nextUnblockable(app: App): BlockedTask | undefined {
  return app.unblockCandidates().find((t) => {
    const repo = app.getRepo(t.repo_id);
    return repo !== undefined && unblockable(t, app.runsForTask(t.id), repo);
  });
}

/**
 * Run an unblock run for a blocked task. The run row opens before anything is awaited, so a second look for the next
 * task (`nextUnblockable`) already sees it. Never throws: a failure ends the row failed and leaves the task as it was.
 */
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
    writeEvent(log, { type: 'agentdeck_error', text: `read plan: ${errorMessage(err)}` });
  }
  const lastWork = app.runsForTask(task.id).findLast((r) => r.kind === 'work');
  const prompt = buildUnblockPrompt(task, {
    plan,
    lastMessage: lastWork?.result_text ?? null,
    reviewNote: latestReviewNote(app.eventsForTask(task.id)),
  });

  const ran = await startTaskRun(app, task, {
    kind: 'unblock',
    repo,
    worktree: wt.path,
    prompt,
    opened,
    maxTurns: Math.min(UNBLOCK_MAX_TURNS, task.max_turns),
    systemPrompt: unblockSystemPrompt(),
  });
  // The run may make a small fix; what it left uncommitted is kept on the branch like a worker's.
  try {
    await app.workspace.commit(wt.path, leftoversMessage(task));
  } catch (err) {
    writeEvent(log, { type: 'agentdeck_error', text: `commit leftovers: ${errorMessage(err)}` });
  }

  const { end, fields } = ran;
  if (end.kind === 'cancelled') {
    await endTaskRun(app, opened, 'cancelled', 'the task is no longer blocked', fields);
    return { outcome: 'cancelled' };
  }
  if (end.kind === 'rate_limited' || end.kind === 'failed') {
    await endTaskRun(app, opened, end.kind, end.reason, fields);
    return { outcome: end.kind, reason: end.reason };
  }
  // Read again: a blocked task's attempts don't change, but a person may have edited max_attempts meanwhile.
  const decision = unblockDecision(parseUnblock(end.result.result), app.getTask(task.id) ?? task);
  writeEvent(log, {
    type: 'agentdeck_unblock',
    text: 'retry' in decision ? `Retried with a note: ${decision.retry}` : `Asked a question: ${decision.ask.question}`,
  });
  await endTaskRun(app, opened, 'retry' in decision ? 'done' : 'blocked', undefined, fields);
  return settleUnblock(app, task.id, decision);
}

/** Queue the task again with the note, or leave the question on it; neither happens if it is no longer blocked. */
async function settleUnblock(app: App, id: TaskId, decision: UnblockDecision): Promise<UnblockReport> {
  if ('retry' in decision) {
    const task = await settle(app, id, { type: 'unblock_retry' }, { reason: decision.retry });
    return task ? { outcome: 'retried', reason: decision.retry } : { outcome: 'stale' };
  }
  const asked = app.recordQuestion(id, decision.ask, decision.ask.question);
  return asked ? { outcome: 'asked', reason: decision.ask.question } : { outcome: 'stale' };
}
