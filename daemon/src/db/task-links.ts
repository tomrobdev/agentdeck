// Task links: what a task depends on, and what depends on it.
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { TaskId } from '../domain/shared/index.ts';
import type { TaskStatus } from '../domain/work/index.ts';
import type { Dependency, Link, LinkKind } from '../domain/work/index.ts';
import type { Orm } from './orm.ts';
import { changed } from './sql.ts';
import { repos, taskLinks, tasks } from './tables.ts';

/** A task that depends on another, and the kind of that link. */
export interface Dependent {
  id: TaskId;
  status: TaskStatus;
  kind: LinkKind;
}

/** A task at the end of a link: what its link states are read from. */
export type LinkedTask = Dependency & { id: TaskId };

/** A link's columns, named as the domain's `Link`. */
const LINK_COLUMNS = { task_id: taskLinks.task_id, on: taskLinks.on_task, kind: taskLinks.kind };

/** Link task `id` to each of `links`. Whether that is allowed (a cycle, a duplicate) is the caller's to check with linkError. */
export function insertLinks(orm: Orm, id: TaskId, links: { on: TaskId; kind: LinkKind }[]): void {
  for (const l of links) orm.insert(taskLinks).values({ task_id: id, on_task: l.on, kind: l.kind }).run();
}

export function taskLinkStore(orm: Orm) {
  return {
    /** The links a task has: what it depends on. */
    linksOf(id: TaskId): Link[] {
      return orm.select(LINK_COLUMNS).from(taskLinks).where(eq(taskLinks.task_id, id)).orderBy(asc(taskLinks.on_task)).all();
    },
    /** Every link there is, for checking a new one for cycles. */
    allLinks(): Link[] {
      return orm.select(LINK_COLUMNS).from(taskLinks).all();
    },
    /** The tasks that depend on `id` (of one kind, if given), in any status: each one's id, status and the kind of its link. */
    dependentsOf(id: TaskId, kind?: LinkKind): Dependent[] {
      return orm
        .select({ id: tasks.id, status: tasks.status, kind: taskLinks.kind })
        .from(tasks)
        .innerJoin(taskLinks, eq(taskLinks.task_id, tasks.id))
        .where(and(eq(taskLinks.on_task, id), kind ? eq(taskLinks.kind, kind) : undefined))
        .orderBy(asc(tasks.id))
        .all();
    },
    /** Every task at either end of a link, with its repo's pr_mode (null when the repo is gone): what link states are read from. */
    linkedTasks(): LinkedTask[] {
      const ends = orm
        .select({ id: taskLinks.task_id })
        .from(taskLinks)
        .union(orm.select({ id: taskLinks.on_task }).from(taskLinks));
      return orm
        .select({
          id: tasks.id,
          status: tasks.status,
          pr_state: tasks.pr_state,
          done_by: tasks.done_by,
          pr_mode: repos.pr_mode,
        })
        .from(tasks)
        .leftJoin(repos, eq(repos.id, tasks.repo_id))
        .where(inArray(tasks.id, ends))
        .all()
        .map(({ pr_state, ...t }) => ({ ...t, pr: pr_state && { state: pr_state }, pr_mode: t.pr_mode ?? 'off' }));
    },
    /** Link `link.task_id` to `link.on`. Whether that is allowed (a cycle, a duplicate) is the caller's to check with linkError. */
    addLink(link: Link): void {
      insertLinks(orm, link.task_id, [link]);
    },
    /** Remove the link from `task_id` to `on`; false if there was none. */
    removeLink(task_id: TaskId, on: TaskId): boolean {
      return changed(
        orm
          .delete(taskLinks)
          .where(and(eq(taskLinks.task_id, task_id), eq(taskLinks.on_task, on)))
          .run(),
      );
    },
  };
}
