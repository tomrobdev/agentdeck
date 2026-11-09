// The verify run of a proposed or queued task, started by a person: claude reads the base in a scratch checkout with
// read-only tools and checks each claim the task's prompt makes about the code. The run stores its findings as its result,
// with the commit it read. It takes a slot, uses no attempt and changes nothing (domain/runs/verify.ts).
import type { App } from '../ports/app.ts';
import type { RunId, TaskId } from '../../domain/shared/index.ts';
import { errorMessage } from '../../domain/shared/index.ts';
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
} from '../../domain/runs/index.ts';
import { CHECKED_STATUSES, type Task, describeWait } from '../../domain/work/index.ts';
import type { Repo } from '../../domain/repos/index.ts';
import { queueWait } from '../capacity/gate.ts';
import { refuse, requireTask, requireTaskRepo } from '../shared/input.ts';
import { type OpenedRun, endTaskRun, openTaskRun, startTaskRun } from './claude-run.ts';

/**
 * What a verify run came to. `done`: it stored its findings; `garbage`: its answer could not be read; `cancelled`: the
 * task stopped being proposed or queued (rejected, cancelled or claimed) while it ran.
 */
export interface VerifyReport {
  outcome: 'done' | 'garbage' | 'failed' | 'rate_limited' | 'cancelled';
  findings: VerifyFinding[];
  /** The base commit it read; null when the checkout could not be made. */
  commit: string | null;
  reason?: string;
}

/** A verify run that has started: its row, and its end, which never rejects. */
export interface VerifyStart {
  run_id: RunId;
  done: Promise<VerifyReport>;
}

/** Whether the task is still one a verify run reads for: proposed or queued. */
const stillChecked = (app: App, id: TaskId): boolean => {
  const status = app.getTask(id)?.status;
  return status !== undefined && CHECKED_STATUSES.includes(status);
};

/**
 * Start a verify run for a proposed or queued task. Refused when the task is in another status, already has one going,
 * or no work may start now (paused, rate limited, the governor says wait, or every slot in use). The row opens before anything is
 * awaited, so a second call finds it going. `done` never rejects: a failure ends the row failed.
 */
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
  return app.workspace.withScratchCheckout(repo, async (checkout) => {
    if ('error' in checkout) throw new Error(`could not check out ${repo.base_branch}: ${checkout.error}`);
    const head = await app.workspace.head(checkout.path);
    const commit = head?.sha ?? null;
    const ran = await startTaskRun(app, task, {
      kind: 'verify',
      repo,
      worktree: checkout.path,
      prompt: buildVerifyPrompt(task, { ref: repo.base_branch, commit: head?.short ?? 'its tip' }),
      opened,
      maxTurns: VERIFY_MAX_TURNS,
      systemPrompt: verifySystemPrompt(),
      tools: VERIFY_TOOLS,
      disallowed: VERIFY_DENIED_TOOLS,
      args: verifySchemaArgs(),
      // Rejected, cancelled or claimed: the prompt it checks is no longer waiting for approval.
      cancelled: () => !stillChecked(app, task.id),
    });
    const { end } = ran;
    const fields = { ...ran.fields, base_commit: commit };
    if (end.kind === 'cancelled') {
      await endTaskRun(app, opened, 'cancelled', 'the task is no longer proposed or queued', fields);
      return { outcome: 'cancelled', findings: [], commit };
    }
    if (end.kind === 'rate_limited' || end.kind === 'failed') {
      await endTaskRun(app, opened, end.kind, end.reason, fields);
      return { outcome: end.kind, findings: [], commit, reason: end.reason };
    }
    const answer = parseVerifyAnswer(end.result.structured_output ?? end.result.result);
    if (!answer) {
      const reason = 'the verify run gave no answer that could be read';
      app.runLog.event(opened.log, { type: 'agentdeck_error', text: reason });
      await endTaskRun(app, opened, 'failed', reason, { ...fields, result_text: reason });
      return { outcome: 'garbage', findings: [], commit, reason };
    }
    // Its result is its findings, as JSON: the Runs tab and `agentdeck show` read them back (runFindings).
    await endTaskRun(app, opened, 'done', undefined, { ...fields, result_text: JSON.stringify(answer) });
    return { outcome: 'done', findings: answer.findings, commit };
  });
}
