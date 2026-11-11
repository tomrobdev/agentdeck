// Escalation: a retry after a failure a stronger model may fix runs one model up (domain/runs/escalate.ts decides).
import type { App } from '../ports/app.ts';
import { type Run, escalation, escalationReason, runSummary } from '../../domain/runs/index.ts';
import type { Needs, Task, TaskStatus } from '../../domain/work/index.ts';
import { present } from '../../domain/shared/index.ts';

export function escalateAfter(
  app: App,
  task: Task,
  run: Run,
  stop: { reason: string | null; needs: Needs | null },
  statuses: TaskStatus[],
): string | null {
  const repo = present(app.getRepo(task.repo_id), `#${task.id}'s repo`);
  const e = escalation(task, run, { ...stop, outcome: run.outcome, denials: run.denials, turns: run.num_turns ?? run.live_turns }, repo);
  if (!e) return null;
  const events = app.runLog.events(run.log_path);
  const verdict = events.length ? runSummary(events, { testCmd: repo.test_cmd, maxTurns: task.max_turns }).verdict : null;
  return app.changeModel(task.id, e, { type: 'escalate', reason: escalationReason(e, verdict) }, statuses) ? e.to : null;
}

export function escalateOnRetry(app: App, task: Task): string | null {
  if (task.status !== 'blocked' && task.status !== 'failed') return null;
  const run = app.runsForTask(task.id).findLast((r) => r.kind === 'work');
  const needs = task.status === 'blocked' ? task.needs : null;
  return run ? escalateAfter(app, task, run, { reason: task.stop_reason, needs }, ['blocked', 'failed']) : null;
}
