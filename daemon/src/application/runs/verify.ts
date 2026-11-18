// The verify run of a proposed or queued task, started by a person: claude reads the base in a scratch checkout with read-only tools and checks each claim the task's prompt makes about the code.
import type { App } from '#application/ports/app.ts';
import type { RunId, TaskId } from '#domain/shared/index.ts';
import { errorMessage } from '#domain/shared/index.ts';
import {
  VERIFY_DENIED_TOOLS,
  VERIFY_MAX_TURNS,
  VERIFY_TOOLS,
  type VerifyFinding,
  buildVerifyPrompt,
  parseVerifyAnswer,
  verifyRefusal,
  verifySchemaArgs,
  verifySystemPrompt,
} from '#domain/runs/index.ts';
import { CHECKED_STATUSES, type Task, describeWait, targetOf } from '#domain/work/index.ts';
import type { Repo } from '#domain/repos/index.ts';
import { queueWait } from '#application/capacity/gate.ts';
import { refuse, requireTask, requireTaskRepo } from '#application/shared/input.ts';
import { type OpenedRun, endTaskRun, openTaskRun, startTaskRun } from '#application/runs/claude-run.ts';

export interface VerifyReport {
  outcome: 'done' | 'garbage' | 'failed' | 'rate_limited' | 'cancelled';
  findings: VerifyFinding[];
  commit: string | null;
  reason?: string;
}

export interface VerifyStart {
  run_id: RunId;
  done: Promise<VerifyReport>;
}

const stillChecked = (app: App, id: TaskId): boolean => {
  const status = app.getTask(id)?.status;
  return status !== undefined && CHECKED_STATUSES.includes(status);
};

export function startVerify(app: App, id: TaskId): VerifyStart {
  const task = requireTask(app, id);
  refuse(verifyRefusal(task, app.runsForTask(id)));
  const repo = requireTaskRepo(app, task);
  const { wait, free } = queueWait(app);
  if (wait) refuse(`a verify run can't start now: ${describeWait(wait)}`);
  if (free <= 0) refuse("a verify run can't start now: every slot is in use");
  const opened = openTaskRun(app, task, 'verify');
  const done = runOpened(app, task, repo, opened).catch(async (err): Promise<VerifyReport> => {
    const reason = errorMessage(err);
    await endTaskRun(app, opened, 'failed', reason).catch(() => {});
    return { outcome: 'failed', findings: [], commit: null, reason };
  });
  return { run_id: opened.runId, done };
}

function runOpened(app: App, task: Task, repo: Repo, opened: OpenedRun): Promise<VerifyReport> {
  const target = targetOf(task, repo);
  return app.workspace.withScratchCheckout(repo, target, async (checkout) => {
    if ('error' in checkout) throw new Error(`could not check out ${target}: ${checkout.error}`);
    const head = await app.workspace.head(checkout.path);
    const commit = head?.sha ?? null;
    const ran = await startTaskRun(app, task, {
      kind: 'verify',
      repo,
      worktree: checkout.path,
      prompt: buildVerifyPrompt(task, { ref: target, commit: head?.short ?? 'its tip' }),
      opened,
      maxTurns: VERIFY_MAX_TURNS,
      systemPrompt: verifySystemPrompt(),
      tools: VERIFY_TOOLS,
      disallowed: VERIFY_DENIED_TOOLS,
      args: verifySchemaArgs(),
      cancelled: () => !stillChecked(app, task.id),
    });
    const { end } = ran;
    const fields = { ...ran.fields, base_commit: commit };
    if (end.kind === 'cancelled') {
      await endTaskRun(app, opened, 'cancelled', 'the task is no longer proposed or queued', fields);
      return { outcome: 'cancelled', findings: [], commit };
    }
    if (end.kind === 'rate_limited' || end.kind === 'failed' || end.kind === 'timed_out') {
      const outcome = end.kind === 'rate_limited' ? end.kind : 'failed';
      await endTaskRun(app, opened, outcome, end.reason, fields);
      return { outcome, findings: [], commit, reason: end.reason };
    }
    const answer = parseVerifyAnswer(end.result.structured_output ?? end.result.result);
    if (!answer) {
      const reason = 'the verify run gave no answer that could be read';
      app.runLog.event(opened.log, { type: 'agentdeck_error', text: reason });
      await endTaskRun(app, opened, 'failed', reason, { ...fields, result_text: reason });
      return { outcome: 'garbage', findings: [], commit, reason };
    }
    await endTaskRun(app, opened, 'done', undefined, { ...fields, result_text: JSON.stringify(answer) });
    return { outcome: 'done', findings: answer.findings, commit };
  });
}
