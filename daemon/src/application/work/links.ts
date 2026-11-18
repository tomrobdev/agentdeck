// Use cases for task links: add one, remove one, and check the lists a new task names.
import type { App } from '#application/ports/app.ts';
import type { RepoId, TaskId } from '#domain/shared/index.ts';
import { present } from '#domain/shared/index.ts';
import {
  type Link,
  type LinkKind,
  type TargetEnd,
  type Task,
  buildsOnError,
  buildsOnRepoError,
  buildsOnTargetError,
  linkError,
} from '#domain/work/index.ts';
import { ActionError, refuse, requireTask } from '#application/shared/input.ts';

export const BUILDS_ON_STARTED = 'builds_on_started';

function buildsOnRepoRefusal(app: App, other: { id: TaskId; repo_id: RepoId }): string | null {
  return buildsOnRepoError(other.id, present(app.getRepo(other.repo_id), `#${other.id}'s repo`));
}

export function targetEnd(app: App, task: Pick<Task, 'id' | 'repo_id' | 'target'>): TargetEnd {
  const repo = present(app.getRepo(task.repo_id), `#${task.id}'s repo`);
  return { id: task.id, repo_id: task.repo_id, target: task.target, base_branch: repo.base_branch };
}

export function refuseCrossTargets(app: App, end: TargetEnd, buildsOn: TaskId[], builders: TaskId[] = []): void {
  for (const on of buildsOn) refuse(buildsOnTargetError(end, targetEnd(app, requireTask(app, on))), undefined, 'conflict');
  for (const id of builders) refuse(buildsOnTargetError(targetEnd(app, requireTask(app, id)), end), undefined, 'conflict');
}

export function newLinks(app: App, input: { builds_on?: TaskId[]; after?: TaskId[] }): { on: TaskId; kind: LinkKind }[] {
  const builds_on = [...new Set(input.builds_on ?? [])];
  const after = [...new Set(input.after ?? [])];
  const both = builds_on.filter((id) => after.includes(id));
  if (both.length) throw new ActionError(`#${both[0]} can't be both built on and landed after`);
  const verb = { builds_on: 'build on', after: 'land after' };
  return [...builds_on.map((on) => ({ on, kind: 'builds_on' as const })), ...after.map((on) => ({ on, kind: 'after' as const }))].map(
    (link) => {
      const target = app.getTask(link.on);
      if (!target) throw new ActionError(`can't ${verb[link.kind]} #${link.on}: no such task`, undefined, 'not_found');
      if (link.kind === 'builds_on') refuse(buildsOnRepoRefusal(app, target));
      return link;
    },
  );
}

export function linkTasks(app: App, id: TaskId, { on, kind }: { on: TaskId; kind: LinkKind }): Link {
  const task = requireTask(app, id);
  if (!app.getTask(on)) throw new ActionError(`no task #${on}`, undefined, 'not_found');
  if (kind === 'builds_on') {
    refuse(buildsOnError(id, task.status, on), BUILDS_ON_STARTED, 'conflict');
    refuse(buildsOnRepoRefusal(app, requireTask(app, on)));
    refuseCrossTargets(app, targetEnd(app, task), [on]);
  }
  refuse(linkError(id, on, app.allLinks()));
  const link: Link = { task_id: id, on, kind };
  app.addLink(link);
  return link;
}

export function unlinkTasks(app: App, id: TaskId, on: TaskId): void {
  requireTask(app, id);
  if (!app.removeLink(id, on)) throw new ActionError(`#${id} is not linked to #${on}`, undefined, 'not_found');
}
