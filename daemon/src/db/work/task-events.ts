// Task history: one row per status change, written with the change itself.
import { and, asc, eq, exists, gt, inArray, lte, max, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { RepoId, TaskId } from '../../domain/shared/index.ts';
import type { PendingFollowUp, TaskEventRow, TaskEventType } from '../../domain/work/index.ts';
import type { TaskStatus } from '../../domain/work/index.ts';
import type { Orm } from '../orm.ts';
import { inActiveRepo } from '../sql.ts';
import { taskEvents, tasks } from '../tables.ts';

const EVENT_COLUMNS = {
  id: taskEvents.id,
  task_id: taskEvents.task_id,
  type: taskEvents.type,
  from_status: taskEvents.from_status,
  to_status: taskEvents.to_status,
  reason: taskEvents.reason,
  at: taskEvents.at,
};

export function recordEvent(
  orm: Orm,
  task_id: TaskId,
  type: TaskEventType,
  from: TaskStatus | null,
  to: TaskStatus,
  reason: string | null = null,
  followUp = false,
): number {
  const info = orm
    .insert(taskEvents)
    .values({ task_id, type, from_status: from, to_status: to, reason, follow_up_pending: followUp ? 1 : 0 })
    .run();
  return Number(info.lastInsertRowid);
}

export function taskEventStore(orm: Orm) {
  return {
    eventsForTask(task_id: TaskId): TaskEventRow[] {
      return orm.select(EVENT_COLUMNS).from(taskEvents).where(eq(taskEvents.task_id, task_id)).orderBy(asc(taskEvents.id)).all();
    },
    pendingFollowUps(): PendingFollowUp[] {
      return orm
        .select({ id: taskEvents.id, task_id: taskEvents.task_id, type: taskEvents.type, to_status: taskEvents.to_status })
        .from(taskEvents)
        .where(eq(taskEvents.follow_up_pending, 1))
        .orderBy(asc(taskEvents.id))
        .all();
    },
    markFollowedUp(ids: number[]): void {
      if (!ids.length) return;
      orm.update(taskEvents).set({ follow_up_pending: 0 }).where(inArray(taskEvents.id, ids)).run();
    },
    lastEventId(): number {
      return (
        orm
          .select({ id: max(taskEvents.id) })
          .from(taskEvents)
          .get()?.id ?? 0
      );
    },
    eventsAfter(after: number, upTo: number, repo_id: RepoId): (TaskEventRow & { title: string })[] {
      return orm
        .select({
          id: taskEvents.id,
          task_id: taskEvents.task_id,
          type: taskEvents.type,
          from_status: taskEvents.from_status,
          to_status: taskEvents.to_status,
          reason: taskEvents.reason,
          at: taskEvents.at,
          title: tasks.title,
        })
        .from(taskEvents)
        .innerJoin(tasks, eq(tasks.id, taskEvents.task_id))
        .where(and(gt(taskEvents.id, after), lte(taskEvents.id, upTo), eq(tasks.repo_id, repo_id)))
        .orderBy(asc(taskEvents.id))
        .all() as (TaskEventRow & { title: string })[];
    },
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
