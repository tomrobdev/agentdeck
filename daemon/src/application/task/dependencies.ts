// Tasks waiting on another through a builds-on link: why they wait, and telling a human when they're stuck.
import type { Db } from '../../db/index.ts';
import type { RepoId, TaskId } from '../../domain/id/id.ts';
import {
  type Link,
  type LinkIndex,
  type LinkKind,
  type LinkState,
  type LinkTarget,
  type StartState,
  linkState,
  releasedBy,
  startState,
  stuckOn,
  unlandedAfter,
} from '../../domain/task/link.ts';
import { isReview, stageOf } from '../../domain/task/stage.ts';
import { type Waiting, waitingOf } from '../../domain/task/start.ts';
import type { Task } from '../../domain/task/task.ts';
import { plural } from '../../domain/text.ts';
import { notifyLater } from '../notifications.ts';

/** A task as a link's other end: its state, its repo's pr_mode and its own links. */
export function targetOf(db: Db, id: TaskId): LinkTarget | undefined {
  const dep = db.getTask(id);
  if (!dep) return undefined;
  return { ...dep, pr_mode: db.getRepo(dep.repo_id)?.pr_mode ?? 'off', links: db.linksOf(id) };
}

/** Link lookups that each query the database when asked. */
export function liveLinks(db: Db): LinkIndex {
  return { linksOf: (id) => db.linksOf(id), dependentsOf: (id) => db.dependentsOf(id), target: (id) => targetOf(db, id) };
}

/** Link lookups from one read of every link and of the tasks at their ends: a fixed number of queries however many tasks and links. */
export function loadedLinks(db: Db): LinkIndex {
  const byTask = new Map<TaskId, Link[]>();
  const byOn = new Map<TaskId, Link[]>();
  const push = (m: Map<TaskId, Link[]>, key: TaskId, l: Link) => m.set(key, [...(m.get(key) ?? []), l]);
  for (const l of db.allLinks()) {
    push(byTask, l.task_id, l);
    push(byOn, l.on, l);
  }
  for (const links of byTask.values()) links.sort((a, b) => a.on - b.on);
  const ends = new Map(db.linkedTasks().map((t) => [t.id, t]));
  const linksOf = (id: TaskId) => byTask.get(id) ?? [];
  return {
    linksOf,
    dependentsOf: (id) =>
      (byOn.get(id) ?? [])
        .flatMap((l) => {
          const t = ends.get(l.task_id);
          return t ? [{ id: t.id, status: t.status, kind: l.kind }] : [];
        })
        .sort((a, b) => a.id - b.id),
    target: (id) => {
      const t = ends.get(id);
      return t && { ...t, links: linksOf(id) };
    },
  };
}

/** The tasks of `refs`, in full, for their titles; one that was deleted meanwhile is left out. */
function tasksOf(db: Db, refs: { id: TaskId }[]): Task[] {
  return refs.flatMap((r) => db.getTask(r.id) ?? []);
}

/** Where a task stands with the tasks it builds on, reading each one and its repo's pr_mode. */
export function dependencyOf(task: Pick<Task, 'id'>, links: LinkIndex): StartState {
  return startState(task, links.linksOf(task.id), links.target);
}

/** What a queued task in start state `dependency` waits for on its builds-on links; null for any other task. */
export function waitingFor(task: Pick<Task, 'status'>, dependency: StartState): Waiting | null {
  return task.status === 'queued' ? waitingOf(dependency) : null;
}

/** The queued tasks merging this one lets start, for a task in review. */
export function unblocksOf(task: Pick<Task, 'id' | 'status' | 'pr'>, links: LinkIndex): TaskId[] {
  if (!isReview(stageOf(task))) return [];
  return releasedBy(task.id, links).map((t) => t.id);
}

/** The queued tasks that building on task `id` alone keeps from starting: merging `id` lets them start. */
export function dependentsReleased(db: Db, id: TaskId): Task[] {
  return tasksOf(db, releasedBy(id, liveLinks(db)));
}

/** One notification naming queued tasks a link leaves without what they wait for: a title and closing line for `n` of them. */
function notifyDependents(
  db: Db,
  tasks: Task[],
  task_id: TaskId | null,
  words: (n: number, them: string) => { title: string; ending: string },
): void {
  const n = tasks.length;
  if (!n) return;
  const { title, ending } = words(n, n === 1 ? 'it' : 'them');
  notifyLater(db, { kind: 'blocked', title, body: [...tasks.map((t) => `• #${t.id} ${t.title}`), ending].join('\n'), task_id });
}

/**
 * Call after task `id` changes in a way that may strand the tasks waiting on it (it failed, was blocked
 * or cancelled, or its PR was closed). If so, notify once, naming every queued task that can no longer start
 * because of it, however many builds-on links down. They stay queued: retrying `id` releases them, so failing them would
 * throw that plan away.
 */
export function warnStuckDependents(db: Db, id: TaskId): void {
  const state = linkState({ on: id, kind: 'builds_on' }, targetOf(db, id));
  if (state.kind !== 'stuck') return;
  notifyDependents(db, tasksOf(db, stuckOn(id, liveLinks(db))), id, (n, them) => ({
    title: `${plural(n, 'task')} can't start: ${state.reason}`,
    ending: `Retry #${id} to release ${them}, or cancel ${them}.`,
  }));
}

/**
 * The queued tasks in other repos that build on one of repo `repoId`'s tasks `taskIds` that is not merged. Deleting the
 * repo takes those links with it, so they would start without that work: read them before, warn about them after.
 */
export function buildersOnRepo(db: Db, repoId: RepoId, taskIds: TaskId[]): Task[] {
  const builders = new Map<TaskId, Task>();
  for (const on of taskIds) {
    if (linkState({ on, kind: 'builds_on' }, targetOf(db, on)).kind === 'met') continue;
    for (const d of db.dependentsOf(on, 'builds_on')) {
      const t = d.status === 'queued' ? db.getTask(d.id) : undefined;
      if (t && t.repo_id !== repoId) builders.set(t.id, t);
    }
  }
  return [...builders.values()].sort((a, b) => a.id - b.id);
}

/** Notify once about the tasks `buildersOnRepo` found, now that repo `repo` is deleted and they start without that work. */
export function warnBuildersOnDeleted(db: Db, repo: string, tasks: Task[]): void {
  notifyDependents(db, tasks, null, (n) => ({
    title: `${plural(n, 'task')} lost what ${n === 1 ? 'it builds' : 'they build'} on: ${repo} was deleted`,
    ending:
      n === 1
        ? 'It starts without that work, which was never merged: cancel it if it needs that work.'
        : 'They start without that work, which was never merged: cancel any that need it.',
  }));
}

/** The after links whose other task has not landed: task `id`'s merge waits for them, each with why. */
export function landsAfter(db: Db, id: TaskId): { on: TaskId; reason: string }[] {
  return unlandedAfter(db.linksOf(id), (on) => targetOf(db, on));
}

/** A task's link as views show it: the other task, the kind and where the link stands. */
export interface LinkView {
  on: TaskId;
  kind: LinkKind;
  state: LinkState['kind'];
}

export function linkViews(id: TaskId, links: LinkIndex): LinkView[] {
  return links.linksOf(id).map((l) => ({ on: l.on, kind: l.kind, state: linkState(l, links.target(l.on)).kind }));
}

/** The tasks that depend on task `id`, whatever their status, each with its link's kind. */
export function dependentViews(id: TaskId, links: LinkIndex): { id: TaskId; kind: LinkKind }[] {
  return links.dependentsOf(id).map((d) => ({ id: d.id, kind: d.kind }));
}
