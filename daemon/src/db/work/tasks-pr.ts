// The writes to a task's pull request: its state, its checks, the auto-merge setting and check, and a person's merge request.
// Each takes its changes from domain/work/lifecycle/task-writes.ts and only persists them under its guard.
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
    /** Whether the daemon may merge the task's PR on its own: true, false, or null for the repo's setting. Not a status, so unguarded. */
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
    /**
     * Keep the PR refresh's latest auto-merge check (JSON { verdict, reasons }) on a task, or clear it with null.
     * Only a done task whose PR is open has one, so a merge or a close recorded meanwhile is never followed by a stale check.
     */
    setAutoMergeCheck(id: TaskId, check: AutoMergeCheck | null): boolean {
      const res = orm
        .update(tasks)
        .set(columns(autoMergeCheckChanges(check)))
        .where(and(eq(tasks.id, id), inReview))
        .run();
      return changed(res);
    },
    /**
     * Record a person's request to merge the task's PR once it is ready. Not a status, but guarded like the merge it asks
     * for: only a done task whose PR is open. A new request starts without a check. Returns false if it was not.
     */
    requestMerge(id: TaskId, method: MergeMethod): boolean {
      const res = orm
        .update(tasks)
        .set({ ...columns(mergeRequestChanges(method)), updated_at: NOW_SQL })
        .where(and(eq(tasks.id, id), inReview))
        .run();
      return changed(res);
    },
    /** Drop a task's merge request. Returns false if it had none. */
    clearMergeRequest(id: TaskId): boolean {
      const res = orm
        .update(tasks)
        .set({ ...columns(noMergeRequestChanges()), updated_at: NOW_SQL })
        .where(and(eq(tasks.id, id), isNotNull(tasks.merge_requested_at)))
        .run();
      return changed(res);
    },
    /**
     * Keep the PR refresh's latest merge request check (JSON { verdict, reasons }) on a task that still has the request.
     * Only a done task whose PR is open, like setAutoMergeCheck: a check finished after a conflict blocked it is dropped.
     */
    setMergeRequestCheck(id: TaskId, check: AutoMergeCheck): boolean {
      const res = orm
        .update(tasks)
        .set(columns(mergeRequestCheckChanges(check)))
        .where(and(eq(tasks.id, id), isNotNull(tasks.merge_requested_at), inReview))
        .run();
      return changed(res);
    },
    /**
     * Keep a done task's open PR's checks as they were the first time they settled (`pr_checks_opened`).
     * Written once: returns false when the PR is not open, or already has them.
     */
    recordPrChecksOpened(id: TaskId, checks: CheckCounts): boolean {
      const res = orm
        .update(tasks)
        .set(columns(prChecksOpenedChanges(checks)))
        .where(and(eq(tasks.id, id), inReview, isNull(tasks.pr_checks_opened)))
        .run();
      return changed(res);
    },
    /**
     * Keep the PR refresh's latest checks (JSON StoredChecks) on a task. Only a done task whose PR is open, like
     * setAutoMergeCheck: checks read while a merge or a close was recorded are dropped. Returns false if it was not.
     */
    setPrChecks(id: TaskId, checks: StoredChecks): boolean {
      const res = orm
        .update(tasks)
        .set(columns(prChecksChanges(checks)))
        .where(and(eq(tasks.id, id), inReview))
        .run();
      return changed(res);
    },
    /**
     * Record a change to a task's PR: `pr_state` (and `pr_url` when opened) and a 'pr' history row (`pr_closed`, pending, for a close), together.
     * Guarded on the PR state the change starts from, like every task write: an opened or failed PR replaces anything
     * but an open one, a close or a sighting only moves an open PR. A merge recorded in between is therefore never
     * undone. A failure needs a done task; an opened PR does not: GitHub has it whatever the task did meanwhile (a
     * retry while it opened), and the task's next finish finds it. Returns false if the task was not in a state the
     * change applies to.
     */
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
        // A closed PR may strand the tasks that build on it: its row is written pending, and the outbox warns them.
        recordEvent(orm, id, e.type === 'closed' ? 'pr_closed' : 'pr', row.status, row.status, reason, e.type === 'closed');
        return true;
      });
    },
    /**
     * Record that a done task's PR was merged: the PR state, the method and a history row, together.
     * Guarded like every task write: only a done task whose PR is open. Returns false if it was not.
     */
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
