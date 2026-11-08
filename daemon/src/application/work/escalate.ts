// Escalation: a retry after a failure a stronger model may fix runs one model up (domain/runs/escalate.ts decides). Used when
// a failed run requeues its task (runs/worker.ts) and when a person retries a blocked or failed task without naming a model
// (landing/person-events.ts); it sits in work/, which both import.
import type { App } from '../ports/app.ts';
import { type Run, escalation, escalationReason, runSummary } from '../../domain/runs/index.ts';
import type { Needs, Task, TaskStatus } from '../../domain/work/index.ts';

/**
 * Move `task`'s model one up for its next attempt when its work run `run`, which stopped for `stop.reason` (with `stop.needs`),
 * failed in a way a stronger model may fix and the repo has escalate on: the model changes and an `escalate` row says why,
 * worded with the run's summary. `statuses` guard the write. Returns the new model, or null when it stays.
 */
export function escalateAfter(
  app: App,
  task: Task,
  run: Run,
  stop: { reason: string | null; needs: Needs | null },
  statuses: TaskStatus[],
): string | null {
  const repo = app.getRepo(task.repo_id);
  if (!repo) return null;
  const e = escalation(task, run, { ...stop, outcome: run.outcome, denials: run.denials, turns: run.num_turns ?? run.live_turns }, repo);
  if (!e) return null;
  const events = app.runLog.events(run.log_path);
  const verdict = events.length ? runSummary(events, { testCmd: repo.test_cmd, maxTurns: task.max_turns }).verdict : null;
  return app.changeModel(task.id, e, { type: 'escalate', reason: escalationReason(e, verdict) }, statuses) ? e.to : null;
}

/** For a person's retry of a blocked or failed task: escalate after its latest work run, as `escalateAfter`. */
export function escalateOnRetry(app: App, task: Task): string | null {
  if (task.status !== 'blocked' && task.status !== 'failed') return null;
  const run = app.runsForTask(task.id).findLast((r) => r.kind === 'work');
  const needs = task.status === 'blocked' ? task.needs : null;
  return run ? escalateAfter(app, task, run, { reason: task.stop_reason, needs }, ['blocked', 'failed']) : null;
}
