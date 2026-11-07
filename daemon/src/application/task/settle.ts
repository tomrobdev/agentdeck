// Settling a task: the daemon's own events that end a run or a wait, applied together with what follows them.
import type { Db } from '../../db/index.ts';
import type { TaskId } from '../../domain/id/id.ts';
import { finalNotification } from '../../domain/notification.ts';
import type { PrEvent } from '../../domain/task/history.ts';
import type { TaskEvent } from '../../domain/task/lifecycle.ts';
import type { Needs } from '../../domain/task/needs.ts';
import type { Task } from '../../domain/task/task.ts';
import { warnStuckDependents } from './dependencies.ts';
import { notifyLater } from '../notifications.ts';
import { openPullRequest } from '../pull-request/open-pr.ts';

/**
 * Apply `event` to task `id` and everything that follows its new status: done opens the PR (unless the PR
 * was just merged, which means it has one) and tells a person, blocked and failed tell a person, and any
 * change warns the tasks waiting on it if they are now stuck. Returns the task as it is afterwards, or
 * undefined (and does nothing else) if the lifecycle refused the event.
 * For the daemon's own events; what a person triggers calls `db.applyEvent` and sends no notification.
 */
export async function settle(
  db: Db,
  id: TaskId,
  event: TaskEvent,
  fields: { reason?: string | null; needs?: Needs | null } = {},
): Promise<Task | undefined> {
  if (!db.applyEvent(id, event, fields)) return undefined;
  return afterSettled(db, id, event.type !== 'pr_merged');
}

/** For tasks the database already moved itself (crash recovery): the effects of their new status. */
export async function settleRecovered(db: Db, ids: TaskId[]): Promise<void> {
  for (const id of ids) await afterSettled(db, id, false);
}

/** A PR's state changed. A closed or failed PR may strand the tasks waiting on its merge. Returns whether it applied. */
export function settlePr(db: Db, id: TaskId, event: PrEvent): boolean {
  if (!db.recordPr(id, event)) return false;
  warnStuckDependents(db, id);
  return true;
}

async function afterSettled(db: Db, id: TaskId, openPr: boolean): Promise<Task | undefined> {
  const task = db.getTask(id);
  if (!task) return undefined;
  // The daemon opens the PR (agents cannot push). Whatever happens, the task stays done.
  const pr = task.status === 'done' && openPr ? await openPullRequest(db, task) : {};
  warnStuckDependents(db, id);
  const note = finalNotification(db.getTask(id) ?? task, db.getRepo(task.repo_id)?.name ?? '', pr);
  if (note) notifyLater(db, note);
  return db.getTask(id);
}
