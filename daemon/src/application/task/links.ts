// Use cases for task links: add one, remove one, and read the lists a new task names.
import type { Db } from '../../db/index.ts';
import { type Link, type LinkKind, linkError } from '../../domain/task/link.ts';
import { ActionError, object, refuse, requireTask } from '../input.ts';

const KINDS: LinkKind[] = ['builds_on', 'after'];

/** Task ids as the CLI types them (12,14) or the API sends them (an array); empty when none are named. */
export function idList(value: unknown, what: string): number[] {
  if (value === undefined || value === null || value === '') return [];
  const items = typeof value === 'string' ? value.split(/[\s,]+/).filter(Boolean) : value;
  if (!Array.isArray(items)) throw new ActionError(`${what} must be a list of task ids`);
  const ids = items.map((i) => (typeof i === 'string' ? Number(i.replace(/^#/, '')) : i));
  if (ids.some((i) => !Number.isInteger(i) || i <= 0)) throw new ActionError(`${what} must be a list of task ids`);
  return [...new Set(ids as number[])];
}

/** The links a new task asks for, checked: every task exists and none is named twice. */
export function newLinks(db: Db, input: { builds_on?: unknown; after?: unknown }): { on: number; kind: LinkKind }[] {
  const builds_on = idList(input.builds_on, 'builds_on');
  const after = idList(input.after, 'after');
  const both = builds_on.filter((id) => after.includes(id));
  if (both.length) throw new ActionError(`#${both[0]} can't be both built on and landed after`);
  const flag = { builds_on: '--builds-on', after: '--after' };
  return [...builds_on.map((on) => ({ on, kind: 'builds_on' as const })), ...after.map((on) => ({ on, kind: 'after' as const }))].map(
    (link) => {
      if (!db.getTask(link.on)) throw new ActionError(`${flag[link.kind]}: no task #${link.on}`);
      return link;
    },
  );
}

/** Make task `id` depend on another. Refused for a self link, a repeat and a cycle (across both kinds), with the reason. */
export function linkTasks(db: Db, id: number, input: { on: number; kind: LinkKind }): Link {
  const body = object(input);
  requireTask(db, id);
  const on = body.on;
  if (typeof on !== 'number' || !Number.isInteger(on)) throw new ActionError('on must be a task id');
  if (!KINDS.includes(body.kind as LinkKind)) throw new ActionError(`kind must be one of ${KINDS.join(', ')}`);
  if (!db.getTask(on)) throw new ActionError(`no task #${on}`);
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
