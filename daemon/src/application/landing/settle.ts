// Every status change and its follow-ups: the daemon's own events that end a run or a wait (settling), and a person's.
import type { App } from '../ports/app.ts';
import type { TaskId } from '../../domain/shared/index.ts';
import { finalNotification } from '../../domain/operations/index.ts';
import type { PersonEvent, TaskEvent, TaskStatus } from '../../domain/work/index.ts';
import type { Needs } from '../../domain/work/index.ts';
import type { Task } from '../../domain/work/index.ts';
import { type FollowUp, followUpsOf, followUpsOfRow } from '../../domain/work/index.ts';
import { warnStuckDependents } from '../work/dependencies.ts';
import { notifyLater } from '../operations/notifications.ts';
import { openPullRequest } from './pull-request/open-pr.ts';

const following = new Set<number>();

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

export function hasFollowUpsToRun(app: App): boolean {
  return app.pendingFollowUps().some((r) => !following.has(r.id));
}

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

async function follow(app: App, id: TaskId, followUps: FollowUp[], to: TaskStatus | null): Promise<Task | undefined> {
  const task = app.getTask(id);
  if (!task) return undefined;
  const pr = followUps.includes('open_pr') && task.status === 'done' ? await openPullRequest(app, task) : {};
  if (followUps.includes('warn_dependents')) warnStuckDependents(app, task.id);
  const now = app.getTask(id) ?? task;
  if (followUps.includes('notify') && now.status === to) {
    const note = finalNotification(now, app.getRepo(task.repo_id)?.name ?? '', pr);
    if (note) notifyLater(app, note);
  }
  return app.getTask(id);
}
