// Every status change and its follow-ups: the daemon's own events that end a run or a wait (settling), and a person's.
// What follows each domain event is the table in domain/work/follow-ups.ts; this module runs it. task_events is the outbox:
// a status change writes its history rows pending in the same transaction, and they are marked once their follow-ups ran,
// so a crash between the two loses nothing. The daemon's tick runs whatever is still pending (`followUpPending`).
import type { App } from '../ports/app.ts';
import type { TaskId } from '../../domain/shared/index.ts';
import { finalNotification } from '../../domain/operations/index.ts';
import type { PersonEvent, TaskEvent, TaskStatus } from '../../domain/work/index.ts';
import type { Needs } from '../../domain/work/index.ts';
import type { Task } from '../../domain/work/index.ts';
import { type FollowUp, followUpsOf, followUpsOfRow } from '../../domain/work/index.ts';
import { warnStuckDependents } from '../work/dependencies.ts';
import { notifyLater } from '../operations/notifications.ts';
import { openPullRequest } from './open-pr.ts';

/**
 * The follow-up lock: the history rows whose follow-ups this process is running now, which `followUpPending` leaves to it.
 * The outbox in the database is what the processes share.
 */
const following = new Set<number>();

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
  const to = applied.task.status;
  return followLocked(app, applied.pending, () => follow(app, id, followUpsOf(applied.event), to));
}

/**
 * Apply a person's `event` to task `id`. Its follow-ups, none of which opens a PR, wait in the outbox for the daemon's next
 * tick: only the daemon runs follow-ups, so a person's event from the CLI reaches it like any other CLI change.
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
  return applied.task;
}

/**
 * Run the follow-ups still pending in the outbox, oldest first, and mark each row: those of a status change the daemon
 * stopped before following up (crash recovery's among them), and a person's events. Rows this process is following up
 * already are left to it. Each follow-up is safe to repeat: a PR already open is not opened again (one GitHub opened before
 * a crash cut off its recording is found and recorded), and a task that has moved on since is not notified about. The
 * lock is this process's: only the daemon runs this (`run-once` refuses to start beside it). Returns how many rows it
 * followed up.
 */
export async function followUpPending(app: App, log: (msg: string) => void = () => {}): Promise<number> {
  const rows = app.pendingFollowUps().filter((r) => !following.has(r.id));
  for (const r of rows) following.add(r.id);
  for (const r of rows) {
    await followLocked(app, [r.id], () => follow(app, r.task_id, followUpsOfRow(r), r.to_status)).catch((err) =>
      log(`task ${r.task_id}: follow-up crashed: ${err?.stack ?? err}`),
    );
  }
  return rows.length;
}

/** Whether the outbox has follow-ups `followUpPending` would run now: pending, and not being run by this process already. */
export function hasFollowUpsToRun(app: App): boolean {
  return app.pendingFollowUps().some((r) => !following.has(r.id));
}

/**
 * Run `follow` with history rows `ids` under the follow-up lock, then mark them followed up, even if it throws: a crash
 * leaves them pending for the next tick, an error does not (it would only fail again, every tick).
 */
async function followLocked<T>(app: App, ids: number[], follow: () => Promise<T>): Promise<T> {
  for (const id of ids) following.add(id);
  try {
    return await follow();
  } finally {
    try {
      app.markFollowedUp(ids);
    } finally {
      for (const id of ids) following.delete(id);
    }
  }
}

/** Run `followUps` for task `id`, as it is now, after a change to status `to`; returns it as they leave it. */
async function follow(app: App, id: TaskId, followUps: FollowUp[], to: TaskStatus | null): Promise<Task | undefined> {
  const task = app.getTask(id);
  if (!task) return undefined;
  // The daemon opens the PR (agents cannot push). Whatever happens, the task stays done.
  const pr = followUps.includes('open_pr') && task.status === 'done' ? await openPullRequest(app, task) : {};
  if (followUps.includes('warn_dependents')) warnStuckDependents(app, task.id);
  // A task that has moved on since (retried, say, before a restart ran this) is told about as it is now, not as it was.
  const now = app.getTask(id) ?? task;
  if (followUps.includes('notify') && now.status === to) {
    const note = finalNotification(now, app.getRepo(task.repo_id)?.name ?? '', pr);
    if (note) notifyLater(app, note);
  }
  return app.getTask(id);
}
