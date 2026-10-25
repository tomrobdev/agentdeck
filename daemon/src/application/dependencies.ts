// Tasks waiting on another with `--after`: why they wait, and telling a human when they're stuck.
import type { Db } from '../db/index.ts';
import { type DependencyState, dependencyState } from '../domain/task/dependency.ts';
import { isReview } from '../domain/task/stage.ts';
import type { Task } from '../domain/task/task.ts';
import { notifyLater } from './notifications.ts';

/** What a queued task with `after_task` is waiting for, or null if it isn't held back. */
export interface Waiting {
  on: number;
  /** Set when the dependency won't get there on its own; null while it is on its way. */
  stuck: string | null;
}

/** Where a task stands with its `after_task`, reading the dependency and its repo's pr_mode. */
export function dependencyOf(db: Db, task: Pick<Task, 'after_task'>): DependencyState {
  const dep = task.after_task === null ? undefined : db.getTask(task.after_task);
  const pr_mode = dep ? (db.getRepo(dep.repo_id)?.pr_mode ?? 'off') : 'off';
  return dependencyState(task, dep && { ...dep, pr_mode });
}

export function waitingFor(db: Db, task: Pick<Task, 'status' | 'after_task'>): Waiting | null {
  if (task.status !== 'queued' || task.after_task === null) return null;
  const state = dependencyOf(db, task);
  if (state.kind === 'waiting') return { on: task.after_task, stuck: null };
  if (state.kind === 'stuck') return { on: task.after_task, stuck: state.reason };
  return null;
}

/** The queued tasks that wait on this one, for a task in review: merging its PR releases them. */
export function unblocksOf(db: Db, task: Pick<Task, 'id' | 'status' | 'pr_state'>): number[] {
  if (!isReview(task)) return [];
  return db.dependentsOf(task.id).map((t) => t.id);
}

/**
 * Call after task `id` changes in a way that may strand the tasks waiting on it (it failed, was blocked
 * or cancelled, or its PR was closed). If so, notify once, naming them. They stay queued: retrying `id`
 * releases them, so failing them would throw that plan away.
 */
export function warnStuckDependents(db: Db, id: number): void {
  const dependents = db.dependentsOf(id);
  if (!dependents.length) return;
  const state = dependencyOf(db, { after_task: id });
  if (state.kind !== 'stuck') return;
  const n = dependents.length;
  notifyLater(db, {
    kind: 'blocked',
    title: `${n} task${n === 1 ? '' : 's'} can't start: ${state.reason}`,
    body: [
      ...dependents.map((t) => `• #${t.id} ${t.title}`),
      `Retry #${id} to release ${n === 1 ? 'it' : 'them'}, or cancel ${n === 1 ? 'it' : 'them'}.`,
    ].join('\n'),
    task_id: id,
  });
}
