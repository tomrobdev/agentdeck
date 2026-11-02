// Tasks waiting on another through a builds-on link: why they wait, and telling a human when they're stuck.
import type { Db } from '../../db/index.ts';
import {
  type LinkKind,
  type LinkLookups,
  type LinkState,
  type LinkTarget,
  type StartState,
  linkState,
  releasedBy,
  startState,
  stuckOn,
  unlandedAfter,
} from '../../domain/task/link.ts';
import { isReview } from '../../domain/task/stage.ts';
import type { Task } from '../../domain/task/task.ts';
import { notifyLater } from '../notifications.ts';

/** What a queued task that builds on others is waiting for, or null if it isn't held back. */
export interface Waiting {
  /** Every task it builds on that is still on its way; or, when stuck, the one root it is stuck on. */
  on: number[];
  /** Set when what it waits for won't get there on its own; null while it is on its way. */
  stuck: string | null;
}

/** A task as a link's other end: its state, its repo's pr_mode and its own links. */
export function targetOf(db: Db, id: number): LinkTarget | undefined {
  const dep = db.getTask(id);
  if (!dep) return undefined;
  return { ...dep, pr_mode: db.getRepo(dep.repo_id)?.pr_mode ?? 'off', links: db.linksOf(id) };
}

/** The lookups the domain's walks over dependents read, from the database. */
function lookups(db: Db): LinkLookups<Task> {
  return {
    buildingOn: (id) => db.dependentsOf(id, 'builds_on'),
    linksOf: (id) => db.linksOf(id),
    target: (id) => targetOf(db, id),
  };
}

/** Where a task stands with the tasks it builds on, reading each one and its repo's pr_mode. */
export function dependencyOf(db: Db, task: Pick<Task, 'id'>): StartState {
  return startState(task, db.linksOf(task.id), (id) => targetOf(db, id));
}

export function waitingFor(db: Db, task: Pick<Task, 'id' | 'status'>): Waiting | null {
  if (task.status !== 'queued') return null;
  const state = dependencyOf(db, task);
  if (state.kind === 'waiting') return { on: state.on, stuck: null };
  if (state.kind === 'stuck') return { on: [state.on], stuck: state.reason };
  return null;
}

/** The queued tasks merging this one lets start, for a task in review. */
export function unblocksOf(db: Db, task: Pick<Task, 'id' | 'status' | 'pr_state'>): number[] {
  if (!isReview(task)) return [];
  return dependentsReleased(db, task.id).map((t) => t.id);
}

/** The queued tasks that building on task `id` alone keeps from starting: merging `id` lets them start. */
export function dependentsReleased(db: Db, id: number): Task[] {
  return releasedBy(id, lookups(db));
}

/** One notification naming queued tasks a link leaves without what they wait for: a title and closing line for `n` of them. */
function notifyDependents(
  db: Db,
  tasks: Task[],
  task_id: number | null,
  words: (n: number, them: string) => { title: string; ending: string },
): void {
  const n = tasks.length;
  if (!n) return;
  const { title, ending } = words(n, n === 1 ? 'it' : 'them');
  notifyLater(db, { kind: 'blocked', title, body: [...tasks.map((t) => `• #${t.id} ${t.title}`), ending].join('\n'), task_id });
}

const tasksWord = (n: number) => `${n} task${n === 1 ? '' : 's'}`;

/**
 * Call after task `id` changes in a way that may strand the tasks waiting on it (it failed, was blocked
 * or cancelled, or its PR was closed). If so, notify once, naming every queued task that can no longer start
 * because of it, however many builds-on links down. They stay queued: retrying `id` releases them, so failing them would
 * throw that plan away.
 */
export function warnStuckDependents(db: Db, id: number): void {
  const state = linkState({ on: id, kind: 'builds_on' }, targetOf(db, id));
  if (state.kind !== 'stuck') return;
  notifyDependents(db, stuckOn(id, lookups(db)), id, (n, them) => ({
    title: `${tasksWord(n)} can't start: ${state.reason}`,
    ending: `Retry #${id} to release ${them}, or cancel ${them}.`,
  }));
}

/**
 * The queued tasks in other repos that build on one of repo `repoId`'s tasks `taskIds` that is not merged. Deleting the
 * repo takes those links with it, so they would start without that work: read them before, warn about them after.
 */
export function buildersOnRepo(db: Db, repoId: number, taskIds: number[]): Task[] {
  const builders = new Map<number, Task>();
  for (const on of taskIds) {
    if (linkState({ on, kind: 'builds_on' }, targetOf(db, on)).kind === 'met') continue;
    for (const t of db.dependentsOf(on, 'builds_on')) if (t.status === 'queued' && t.repo_id !== repoId) builders.set(t.id, t);
  }
  return [...builders.values()].sort((a, b) => a.id - b.id);
}

/** Notify once about the tasks `buildersOnRepo` found, now that repo `repo` is deleted and they start without that work. */
export function warnBuildersOnDeleted(db: Db, repo: string, tasks: Task[]): void {
  notifyDependents(db, tasks, null, (n) => ({
    title: `${tasksWord(n)} lost what ${n === 1 ? 'it builds' : 'they build'} on: ${repo} was deleted`,
    ending:
      n === 1
        ? 'It starts without that work, which was never merged: cancel it if it needs that work.'
        : 'They start without that work, which was never merged: cancel any that need it.',
  }));
}

/** The after links whose other task has not landed: task `id`'s merge waits for them, each with why. */
export function landsAfter(db: Db, id: number): { on: number; reason: string }[] {
  return unlandedAfter(db.linksOf(id), (on) => targetOf(db, on));
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
