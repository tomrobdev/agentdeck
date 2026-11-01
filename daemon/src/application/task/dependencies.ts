// Tasks waiting on another through a builds-on link: why they wait, and telling a human when they're stuck.
import type { Db } from '../../db/index.ts';
import {
  type LinkKind,
  type LinkState,
  type LinkTarget,
  type StartState,
  linkState,
  mergeHold,
  startState,
} from '../../domain/task/link.ts';
import { isReview } from '../../domain/task/stage.ts';
import type { Task } from '../../domain/task/task.ts';
import { notifyLater } from '../notifications.ts';

/** What a queued task that builds on others is waiting for, or null if it isn't held back. */
export interface Waiting {
  on: number;
  /** Set when what it waits for won't get there on its own; null while it is on its way. */
  stuck: string | null;
}

/** A task as a link's other end: its state, its repo's pr_mode and its own links. */
export function targetOf(db: Db, id: number): LinkTarget | undefined {
  const dep = db.getTask(id);
  if (!dep) return undefined;
  return { ...dep, pr_mode: db.getRepo(dep.repo_id)?.pr_mode ?? 'off', links: db.linksOf(id) };
}

/** Where a task stands with the tasks it builds on, reading each one and its repo's pr_mode. */
export function dependencyOf(db: Db, task: Pick<Task, 'id'>): StartState {
  return startState(task, db.linksOf(task.id), (id) => targetOf(db, id));
}

export function waitingFor(db: Db, task: Pick<Task, 'id' | 'status'>): Waiting | null {
  if (task.status !== 'queued') return null;
  const state = dependencyOf(db, task);
  if (state.kind === 'waiting') return { on: state.on[0], stuck: null };
  if (state.kind === 'stuck') return { on: state.on, stuck: state.reason };
  return null;
}

/** The queued tasks that build on this one and so wait for it. */
function queuedBuildingOn(db: Db, id: number): Task[] {
  return db.dependentsOf(id, 'builds_on').filter((t) => t.status === 'queued');
}

/** The queued tasks that wait on this one, for a task in review: merging its PR releases them. */
export function unblocksOf(db: Db, task: Pick<Task, 'id' | 'status' | 'pr_state'>): number[] {
  if (!isReview(task)) return [];
  return queuedBuildingOn(db, task.id).map((t) => t.id);
}

/** The queued tasks that wait on task `id`. */
export function dependentsWaiting(db: Db, id: number): Task[] {
  return queuedBuildingOn(db, id);
}

/**
 * Call after task `id` changes in a way that may strand the tasks waiting on it (it failed, was blocked
 * or cancelled, or its PR was closed). If so, notify once, naming every queued task that can no longer start,
 * however many builds-on links down. They stay queued: retrying `id` releases them, so failing them would
 * throw that plan away.
 */
export function warnStuckDependents(db: Db, id: number): void {
  const state = linkState({ on: id, kind: 'builds_on' }, targetOf(db, id));
  if (state.kind !== 'stuck') return;
  const stuck = new Map<number, Task>();
  const seen = new Set<number>([id]);
  const stack = [id];
  while (stack.length) {
    for (const t of db.dependentsOf(stack.pop()!, 'builds_on')) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      if (t.status === 'queued') stuck.set(t.id, t);
      // A done task has started already, so what builds on it is not held by this chain.
      if (t.status !== 'done') stack.push(t.id);
    }
  }
  const dependents = [...stuck.values()].sort((a, b) => a.id - b.id);
  if (!dependents.length) return;
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

/** The after links that still hold task `id`'s merge, each with why. */
export function landsAfter(db: Db, id: number): { on: number; reason: string }[] {
  return mergeHold(db.linksOf(id), (on) => targetOf(db, on));
}

/** A task's link as views show it: the other task, the kind and where the link stands. */
export interface LinkView {
  on: number;
  kind: LinkKind;
  state: LinkState['kind'];
}

export function linkViews(db: Db, id: number): LinkView[] {
  return db.linksOf(id).map((l) => ({ on: l.on, kind: l.kind, state: linkState(l, targetOf(db, l.on)).kind }));
}

/** The tasks that depend on task `id`, whatever their status. */
export function dependentViews(db: Db, id: number): { id: number; kind: LinkKind }[] {
  return db
    .dependentsOf(id)
    .map((t) => ({ id: t.id, kind: db.linksOf(t.id).find((l) => l.on === id)!.kind }))
    .sort((a, b) => a.id - b.id);
}
