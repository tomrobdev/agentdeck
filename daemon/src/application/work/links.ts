// Use cases for task links: add one, remove one, and check the lists a new task names.
import type { App } from '../ports/app.ts';
import type { TaskId } from '../../domain/shared/index.ts';
import { type Link, type LinkKind, buildsOnError, linkError } from '../../domain/work/index.ts';
import { ActionError, refuse, requireTask } from '../shared/input.ts';

/** The code of the error for a builds-on link on a task that has started already (`ActionError.code`). */
export const BUILDS_ON_STARTED = 'builds_on_started';

/** The links a new task asks for, checked: every task exists and none is named under both kinds. The entry points parse the ids. */
export function newLinks(app: App, input: { builds_on?: TaskId[]; after?: TaskId[] }): { on: TaskId; kind: LinkKind }[] {
  const builds_on = [...new Set(input.builds_on ?? [])];
  const after = [...new Set(input.after ?? [])];
  const both = builds_on.filter((id) => after.includes(id));
  if (both.length) throw new ActionError(`#${both[0]} can't be both built on and landed after`);
  const verb = { builds_on: 'build on', after: 'land after' };
  return [...builds_on.map((on) => ({ on, kind: 'builds_on' as const })), ...after.map((on) => ({ on, kind: 'after' as const }))].map(
    (link) => {
      if (!app.getTask(link.on)) throw new ActionError(`can't ${verb[link.kind]} #${link.on}: no such task`);
      return link;
    },
  );
}

/**
 * Make task `id` depend on another. Refused for a self link, a repeat and a cycle (across both kinds), and for a
 * builds-on link on a task that has started already, with the reason.
 */
export function linkTasks(app: App, id: TaskId, { on, kind }: { on: TaskId; kind: LinkKind }): Link {
  const task = requireTask(app, id);
  if (!app.getTask(on)) throw new ActionError(`no task #${on}`);
  if (kind === 'builds_on') refuse(buildsOnError(id, task.status, on), BUILDS_ON_STARTED);
  refuse(linkError(id, on, app.allLinks()));
  const link: Link = { task_id: id, on, kind };
  app.addLink(link);
  return link;
}

/** Remove task `id`'s link to `on`. */
export function unlinkTasks(app: App, id: TaskId, on: TaskId): void {
  requireTask(app, id);
  if (!app.removeLink(id, on)) throw new ActionError(`#${id} is not linked to #${on}`);
}
