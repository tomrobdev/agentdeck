// Task links: what a task depends on, and what depends on it.
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { TaskId } from '#domain/shared/index.ts';
import { type Dependent, type Link, type LinkKind, type LinkedTask, placeAt } from '#domain/work/index.ts';
import type { Orm } from '#db/orm.ts';
import { changed } from '#db/sql.ts';
import { planBranches, repos, taskLinks, tasks } from '#db/tables.ts';

const LINK_COLUMNS = { task_id: taskLinks.task_id, on: taskLinks.on_task, kind: taskLinks.kind };

export function insertLinks(orm: Orm, id: TaskId, links: { on: TaskId; kind: LinkKind }[]): void {
  for (const l of links) orm.insert(taskLinks).values({ task_id: id, on_task: l.on, kind: l.kind }).run();
}

export function taskLinkStore(orm: Orm) {
  return {
    linksOf(id: TaskId): Link[] {
      return orm.select(LINK_COLUMNS).from(taskLinks).where(eq(taskLinks.task_id, id)).orderBy(asc(taskLinks.on_task)).all();
    },
    allLinks(): Link[] {
      return orm.select(LINK_COLUMNS).from(taskLinks).all();
    },
    dependentsOf(id: TaskId, kind?: LinkKind): Dependent[] {
      return orm
        .select({ id: tasks.id, status: tasks.status, kind: taskLinks.kind })
        .from(tasks)
        .innerJoin(taskLinks, eq(taskLinks.task_id, tasks.id))
        .where(and(eq(taskLinks.on_task, id), kind ? eq(taskLinks.kind, kind) : undefined))
        .orderBy(asc(tasks.id))
        .all();
    },
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
          target: tasks.target,
          base_branch: repos.base_branch,
          plan_branch: planBranches.status,
        })
        .from(tasks)
        .leftJoin(repos, eq(repos.id, tasks.repo_id))
        .leftJoin(planBranches, and(eq(planBranches.repo_id, tasks.repo_id), eq(planBranches.name, tasks.target)))
        .where(inArray(tasks.id, ends))
        .all()
        .map(({ pr_state, target, base_branch, plan_branch, ...t }) => ({
          ...t,
          pr: pr_state && { state: pr_state },
          pr_mode: t.pr_mode ?? 'off',
          place: placeAt(target, base_branch ?? '', plan_branch),
        }));
    },
    addLink(link: Link): void {
      insertLinks(orm, link.task_id, [link]);
    },
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
