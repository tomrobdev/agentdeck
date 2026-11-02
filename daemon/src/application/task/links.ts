// Use cases for task links: add one, remove one, and check the lists a new task names.
import type { Db } from '../../db/index.ts';
import { type Link, type LinkKind, buildsOnError, linkError } from '../../domain/task/link.ts';
import { ActionError, object, refuse, requireTask } from '../input.ts';

const KINDS: LinkKind[] = ['builds_on', 'after'];

/** The links a new task asks for, checked: every task exists and none is named under both kinds. The entry points parse the ids. */
export function newLinks(db: Db, input: { builds_on?: number[]; after?: number[] }): { on: number; kind: LinkKind }[] {
  const builds_on = [...new Set(input.builds_on ?? [])];
  const after = [...new Set(input.after ?? [])];
  const both = builds_on.filter((id) => after.includes(id));
  if (both.length) throw new ActionError(`#${both[0]} can't be both built on and landed after`);
  const verb = { builds_on: 'build on', after: 'land after' };
  return [...builds_on.map((on) => ({ on, kind: 'builds_on' as const })), ...after.map((on) => ({ on, kind: 'after' as const }))].map(
    (link) => {
      if (!db.getTask(link.on)) throw new ActionError(`can't ${verb[link.kind]} #${link.on}: no such task`);
      return link;
    },
  );
}

/**
 * Make task `id` depend on another. Refused for a self link, a repeat and a cycle (across both kinds), and for a
 * builds-on link on a task that has started already, with the reason.
 */
export function linkTasks(db: Db, id: number, input: { on: number; kind: LinkKind }): Link {
  const body = object(input);
  const task = requireTask(db, id);
  const on = body.on;
  if (typeof on !== 'number' || !Number.isInteger(on)) throw new ActionError('on must be a task id');
  if (!KINDS.includes(body.kind as LinkKind)) throw new ActionError(`kind must be one of ${KINDS.join(', ')}`);
  if (!db.getTask(on)) throw new ActionError(`no task #${on}`);
  if (body.kind === 'builds_on') refuse(buildsOnError(id, task.status, on));
  refuse(linkError(id, on, db.allLinks()));
  const link: Link = { task_id: id, on, kind: body.kind as LinkKind };
  db.addLink(link);
  return link;
}

/** Remove task `id`'s link to `on`. */
export function unlinkTasks(db: Db, id: number, on: number): void {
  requireTask(db, id);
  if (!Number.isInteger(on)) throw new ActionError('on must be a task id');
  if (!db.removeLink(id, on)) throw new ActionError(`#${id} is not linked to #${on}`);
}
