// Tasks waiting on another through a builds-on link: why they wait, and telling a human when they're stuck.
import type { App } from '#application/ports/app.ts';
import type { RepoId, TaskId } from '#domain/shared/index.ts';
import { type Link, type LinkIndex, type LinkTarget, linkState, releasedBy, stuckOn, unlandedAfter } from '#domain/work/index.ts';
import type { Task } from '#domain/work/index.ts';
import { plural } from '#domain/shared/index.ts';
import { notifyLater } from '#application/operations/notifications.ts';

export function targetOf(app: App, id: TaskId): LinkTarget | undefined {
  const dep = app.getTask(id);
  if (!dep) return undefined;
  return { ...dep, pr_mode: app.getRepo(dep.repo_id)?.pr_mode ?? 'off', links: app.linksOf(id) };
}

export function liveLinks(app: App): LinkIndex {
  return { linksOf: (id) => app.linksOf(id), dependentsOf: (id) => app.dependentsOf(id), target: (id) => targetOf(app, id) };
}

export function loadedLinks(app: App): LinkIndex {
  const byTask = new Map<TaskId, Link[]>();
  const byOn = new Map<TaskId, Link[]>();
  const push = (m: Map<TaskId, Link[]>, key: TaskId, l: Link) => m.set(key, [...(m.get(key) ?? []), l]);
  for (const l of app.allLinks()) {
    push(byTask, l.task_id, l);
    push(byOn, l.on, l);
  }
  for (const links of byTask.values()) links.sort((a, b) => a.on - b.on);
  const ends = new Map(app.linkedTasks().map((t) => [t.id, t]));
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

function tasksOf(app: App, refs: { id: TaskId }[]): Task[] {
  return refs.flatMap((r) => app.getTask(r.id) ?? []);
}

export function dependentsReleased(app: App, id: TaskId): Task[] {
  return tasksOf(app, releasedBy(id, liveLinks(app)));
}

function notifyDependents(
  app: App,
  tasks: Task[],
  task_id: TaskId | null,
  words: (n: number, them: string) => { title: string; ending: string },
): void {
  const n = tasks.length;
  if (!n) return;
  const { title, ending } = words(n, n === 1 ? 'it' : 'them');
  notifyLater(app, { kind: 'blocked', title, body: [...tasks.map((t) => `• #${t.id} ${t.title}`), ending].join('\n'), task_id });
}

export function warnStuckDependents(app: App, id: TaskId): void {
  const state = linkState({ on: id, kind: 'builds_on' }, targetOf(app, id));
  if (state.kind !== 'stuck') return;
  notifyDependents(app, tasksOf(app, stuckOn(id, liveLinks(app))), id, (n, them) => ({
    title: `${plural(n, 'task')} can't start: ${state.reason}`,
    ending: `Retry #${id} to release ${them}, or cancel ${them}.`,
  }));
}

export function buildersOnRepo(app: App, repoId: RepoId, taskIds: TaskId[]): Task[] {
  const builders = new Map<TaskId, Task>();
  for (const on of taskIds) {
    if (linkState({ on, kind: 'builds_on' }, targetOf(app, on)).kind === 'met') continue;
    for (const d of app.dependentsOf(on, 'builds_on')) {
      const t = d.status === 'queued' ? app.getTask(d.id) : undefined;
      if (t && t.repo_id !== repoId) builders.set(t.id, t);
    }
  }
  return [...builders.values()].sort((a, b) => a.id - b.id);
}

export function warnBuildersOnDeleted(app: App, repo: string, tasks: Task[]): void {
  notifyDependents(app, tasks, null, (n) => ({
    title: `${plural(n, 'task')} lost what ${n === 1 ? 'it builds' : 'they build'} on: ${repo} was deleted`,
    ending:
      n === 1
        ? 'It starts without that work, which was never merged: cancel it if it needs that work.'
        : 'They start without that work, which was never merged: cancel any that need it.',
  }));
}

export function landsAfter(app: App, id: TaskId): { on: TaskId; reason: string }[] {
  return unlandedAfter(app.linksOf(id), (on) => targetOf(app, on));
}
