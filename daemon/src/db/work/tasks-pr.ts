// The writes to a task's pull request: its state, its checks, the auto-merge setting and check, and a person's merge request.
import { type SQL, and, eq, isNotNull, isNull, ne, not, or } from 'drizzle-orm';
import type { DatabaseSync } from 'node:sqlite';
import type { TaskId } from '../../domain/shared/index.ts';
import type { AutoMergeCheck, CheckCounts, StoredChecks } from '../../domain/landing/index.ts';
import type { MergeMethod } from '../../domain/repos/index.ts';
import {
  type PrEvent,
  type Task,
  type TaskStatus,
  autoMergeCheckChanges,
  autoMergeSettingChanges,
  mergeRequestChanges,
  mergeRequestCheckChanges,
  mergedPrChanges,
  noMergeRequestChanges,
  prChanges,
  prChecksChanges,
  prChecksOpenedChanges,
  prEventReason,
} from '../../domain/work/index.ts';
import { TASK_COLUMNS, mapFound, toTask } from '../mappers.ts';
import type { Orm } from '../orm.ts';
import { NOW_SQL, atomically, changed } from '../sql.ts';
import { tasks } from '../tables.ts';
import { recordEvent } from './task-events.ts';
import { columns, inReview, prOpen } from './tasks-columns.ts';

export function taskPrStore(db: DatabaseSync, orm: Orm) {
  return {
    setAutoMerge(id: TaskId, value: boolean | null): Task | undefined {
      return mapFound(
        orm
          .update(tasks)
          .set({ ...columns(autoMergeSettingChanges(value)), updated_at: NOW_SQL })
          .where(eq(tasks.id, id))
          .returning(TASK_COLUMNS)
          .get(),
        toTask,
      );
    },
    setAutoMergeCheck(id: TaskId, check: AutoMergeCheck | null): boolean {
      const res = orm
        .update(tasks)
        .set(columns(autoMergeCheckChanges(check)))
        .where(and(eq(tasks.id, id), inReview))
        .run();
      return changed(res);
    },
    requestMerge(id: TaskId, method: MergeMethod): boolean {
      const res = orm
        .update(tasks)
        .set({ ...columns(mergeRequestChanges(method)), updated_at: NOW_SQL })
        .where(and(eq(tasks.id, id), inReview))
        .run();
      return changed(res);
    },
    clearMergeRequest(id: TaskId): boolean {
      const res = orm
        .update(tasks)
        .set({ ...columns(noMergeRequestChanges()), updated_at: NOW_SQL })
        .where(and(eq(tasks.id, id), isNotNull(tasks.merge_requested_at)))
        .run();
      return changed(res);
    },
    setMergeRequestCheck(id: TaskId, check: AutoMergeCheck): boolean {
      const res = orm
        .update(tasks)
        .set(columns(mergeRequestCheckChanges(check)))
        .where(and(eq(tasks.id, id), isNotNull(tasks.merge_requested_at), inReview))
        .run();
      return changed(res);
    },
    recordPrChecksOpened(id: TaskId, checks: CheckCounts): boolean {
      const res = orm
        .update(tasks)
        .set(columns(prChecksOpenedChanges(checks)))
        .where(and(eq(tasks.id, id), inReview, isNull(tasks.pr_checks_opened)))
        .run();
      return changed(res);
    },
    setPrChecks(id: TaskId, checks: StoredChecks): boolean {
      const res = orm
        .update(tasks)
        .set(columns(prChecksChanges(checks)))
        .where(and(eq(tasks.id, id), inReview))
        .run();
      return changed(res);
    },
    recordPr(id: TaskId, e: PrEvent): boolean {
      const notOpen = or(isNull(tasks.pr_state), not(prOpen));
      const isOpen = prOpen;
      const reason = prEventReason(e);
      const guard: SQL | undefined =
        e.type === 'opened'
          ? notOpen
          : e.type === 'failed'
            ? and(notOpen, eq(tasks.status, 'done'))
            : e.type === 'closed'
              ? isOpen
              : and(isOpen, ne(tasks.pr_state, e.state));
      return atomically(db, () => {
        const row = orm
          .update(tasks)
          .set({ ...columns(prChanges(e)), updated_at: NOW_SQL })
          .where(and(eq(tasks.id, id), guard))
          .returning({ status: tasks.status })
          .get() as { status: TaskStatus } | undefined;
        if (!row) return false;
        recordEvent(orm, id, e.type === 'closed' ? 'pr_closed' : 'pr', row.status, row.status, reason, e.type === 'closed');
        return true;
      });
    },
    recordMerge(id: TaskId, method: MergeMethod, reason: string, checks?: CheckCounts): boolean {
      return atomically(db, () => {
        const res = orm
          .update(tasks)
          .set({ ...columns(mergedPrChanges(method, checks)), updated_at: NOW_SQL })
          .where(and(eq(tasks.id, id), inReview))
          .run();
        if (!changed(res)) return false;
        recordEvent(orm, id, 'merge', 'done', 'done', reason);
        return true;
      });
    },
  };
}
