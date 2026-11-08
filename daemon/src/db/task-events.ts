// Task history: one row per status change, written with the change itself.
import { and, asc, eq, exists, getColumns, gt, lte, max, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { RepoId, TaskId } from '../domain/shared/index.ts';
import type { TaskEventRow, TaskEventType } from '../domain/work/index.ts';
import type { TaskStatus } from '../domain/work/index.ts';
import type { Orm } from './orm.ts';
import { inActiveRepo } from './sql.ts';
import { taskEvents, tasks } from './tables.ts';

/** Append to a task's history. Callers run it in the same `atomically` block as the status change. */
export function recordEvent(
  orm: Orm,
  task_id: TaskId,
  type: TaskEventType,
  from: TaskStatus | null,
  to: TaskStatus,
  reason: string | null = null,
) {
  return orm.insert(taskEvents).values({ task_id, type, from_status: from, to_status: to, reason }).run();
}

export function taskEventStore(orm: Orm) {
  return {
    /** A task's status changes, oldest first. Tasks from before migration step 6 have none. */
    eventsForTask(task_id: TaskId): TaskEventRow[] {
      return orm.select().from(taskEvents).where(eq(taskEvents.task_id, task_id)).orderBy(asc(taskEvents.id)).all();
    },
    /** The newest history row's id, 0 when there is none: a cursor for `eventsAfter`. */
    lastEventId(): number {
      return (
        orm
          .select({ id: max(taskEvents.id) })
          .from(taskEvents)
          .get()?.id ?? 0
      );
    },
    /** A repo's history rows after `after`, up to `upTo` inclusive, oldest first, each with its task's title. */
    eventsAfter(after: number, upTo: number, repo_id: RepoId): (TaskEventRow & { title: string })[] {
      return orm
        .select({ ...getColumns(taskEvents), title: tasks.title })
        .from(taskEvents)
        .innerJoin(tasks, eq(tasks.id, taskEvents.task_id))
        .where(and(gt(taskEvents.id, after), lte(taskEvents.id, upTo), eq(tasks.repo_id, repo_id)))
        .orderBy(asc(taskEvents.id))
        .all() as (TaskEventRow & { title: string })[];
    },
    /** Done tasks whose latest run left linked plan steps unfinished: the ids, for the list's badge. */
    planUnfinishedIds(): Set<number> {
      const e = alias(taskEvents, 'e');
      const c = alias(taskEvents, 'c');
      const lastClaim = orm
        .select({ id: max(c.id) })
        .from(c)
        .where(and(eq(c.task_id, tasks.id), eq(c.type, 'claim')));
      const unfinishedSince = orm
        .select({ id: e.id })
        .from(e)
        // guard: the builder has no COALESCE; a task never claimed has no claim row, so the cursor is 0
        .where(and(eq(e.task_id, tasks.id), eq(e.type, 'plan_unfinished'), gt(e.id, sql`COALESCE(${lastClaim}, 0)`)));
      const rows = orm
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.status, 'done'), inActiveRepo(orm, tasks.repo_id), exists(unfinishedSince)))
        .all();
      return new Set(rows.map((r) => r.id));
    },
  };
}
