// Every status change and its follow-ups: the daemon's own events that end a run or a wait (settling), and a person's.
// What follows each domain event is the table in domain/work/follow-ups.ts; this module runs it.
import type { App } from '../ports/app.ts';
import type { TaskId } from '../../domain/shared/index.ts';
import { finalNotification } from '../../domain/operations/index.ts';
import type { PrEvent } from '../../domain/work/index.ts';
import type { PersonEvent, TaskEvent, TaskStatus } from '../../domain/work/index.ts';
import type { Needs } from '../../domain/work/index.ts';
import type { Task } from '../../domain/work/index.ts';
import { FOLLOW_UPS, type FollowUp, followUpsOf } from '../../domain/work/index.ts';
import { warnStuckDependents } from '../work/dependencies.ts';
import { notifyLater } from '../operations/notifications.ts';
import { openPullRequest } from './open-pr.ts';

/**
 * Apply the daemon's `event` to task `id` and run its follow-ups (`FOLLOW_UPS`): a finished run opens the PR, and so on.
 * Returns the task as it is afterwards, or undefined (and does nothing else) if the lifecycle refused the event.
 */
export async function settle(
  app: App,
  id: TaskId,
  event: TaskEvent,
  fields: { reason?: string | null; needs?: Needs | null } = {},
): Promise<Task | undefined> {
  const applied = app.applyEvent(id, event, fields);
  if (!applied) return undefined;
  return follow(app, id, followUpsOf(applied.events));
}

/**
 * Apply a person's `event` to task `id` and run its follow-ups, none of which opens a PR, so all are done when it returns.
 * Returns the task as the change left it, or undefined if the lifecycle refused the event (or `onlyFrom` left it out).
 */
export function applyPersonEvent(
  app: App,
  id: TaskId,
  event: { type: PersonEvent },
  opts: { reason?: string | null; onlyFrom?: TaskStatus[] } = {},
): Task | undefined {
  const applied = app.applyEvent(id, event, opts);
  if (!applied) return undefined;
  const followUps = followUpsOf(applied.events);
  if (followUps.includes('open_pr')) throw new Error(`a person's ${event.type} cannot open a PR`);
  followUp(app, applied.task, followUps);
  return applied.task;
}

/** For tasks crash recovery failed (the database moved them itself): the follow-ups of a failed task. */
export async function settleRecovered(app: App, ids: TaskId[]): Promise<void> {
  for (const id of ids) await follow(app, id, FOLLOW_UPS.TaskFailed);
}

/** A PR's state changed. A closed or failed PR may strand the tasks waiting on its merge. Returns whether it applied. */
export function settlePr(app: App, id: TaskId, event: PrEvent): boolean {
  if (!app.recordPr(id, event)) return false;
  warnStuckDependents(app, id);
  return true;
}

/** Run `followUps` for task `id`, as it is now; returns it as they leave it. */
async function follow(app: App, id: TaskId, followUps: FollowUp[]): Promise<Task | undefined> {
  const task = app.getTask(id);
  if (!task) return undefined;
  // The daemon opens the PR (agents cannot push). Whatever happens, the task stays done.
  const pr = followUps.includes('open_pr') && task.status === 'done' ? await openPullRequest(app, task) : {};
  followUp(app, task, followUps, pr);
  return app.getTask(id);
}

/** The follow-ups after the PR: warn the tasks waiting on `task` if they are now stuck, and tell a person. */
function followUp(app: App, task: Task, followUps: FollowUp[], pr: { url?: string; error?: string } = {}): void {
  if (followUps.includes('warn_dependents')) warnStuckDependents(app, task.id);
  if (!followUps.includes('notify')) return;
  const note = finalNotification(app.getTask(task.id) ?? task, app.getRepo(task.repo_id)?.name ?? '', pr);
  if (note) notifyLater(app, note);
}
