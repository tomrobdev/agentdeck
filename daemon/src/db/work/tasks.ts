// Tasks: one store merged from its reads (tasks-queries.ts), its status changes (tasks-status.ts, every one through
// applyEvent, the claim included, guarded by the current status) and its PR writes (tasks-pr.ts), with the other writes here.
import { and, eq, inArray } from 'drizzle-orm';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULTS } from '../../config.ts';
import { type RepoId, type TaskId, asTaskId, stored } from '../../domain/shared/index.ts';
import {
  DEFAULT_MODEL,
  EDITABLE_STATUSES,
  type LinkKind,
  PLAN_ATTACHABLE_STATUSES,
  type Task,
  type TaskPlan,
  type TaskStatus,
  type UnblockQuestion,
  modelChanges,
  questionChanges,
} from '../../domain/work/index.ts';
import { TASK_COLUMNS, mapFound, toTask } from '../mappers.ts';
import type { Orm } from '../orm.ts';
import { NOW_SQL, atomically } from '../sql.ts';
import { tasks } from '../tables.ts';
import { insertOwnPlan, saveOwnPlan } from './plans.ts';
import { recordEvent } from './task-events.ts';
import { insertLinks } from './task-links.ts';
import { columns, given } from './tasks-columns.ts';
import { taskPrStore } from './tasks-pr.ts';
import { taskQueries } from './tasks-queries.ts';
import { taskStatusStore } from './tasks-status.ts';

export function taskStore(db: DatabaseSync, orm: Orm) {
  const queries = taskQueries(orm);
  const { getTask } = queries;

  /**
   * Touch a task that is in one of `statuses` and record a history row of `type` for it, which leaves the status as it is.
   * Returns false if the task is missing or in another status.
   */
  const noteEvent = (id: TaskId, statuses: TaskStatus[], type: 'sync' | 'plan_unfinished', reason: string): boolean =>
    atomically(db, () => {
      const row = orm
        .update(tasks)
        .set({ updated_at: NOW_SQL })
        .where(and(eq(tasks.id, id), inArray(tasks.status, statuses)))
        .returning({ status: tasks.status })
        .get() as { status: TaskStatus } | undefined;
      if (!row) return false;
      recordEvent(orm, id, type, row.status, row.status, reason);
      return true;
    });

  return {
    ...queries,
    ...taskStatusStore(db, orm, getTask),
    ...taskPrStore(db, orm),
    addTask(n: {
      repo_id: RepoId;
      title: string;
      prompt: string;
      priority?: number;
      /**
       * Required on the port (`NewTask`), so every use case decides it with `newTaskModel`; only a direct store call (a test)
       * leaves it out and gets the default_model setting's default.
       */
      model?: string;
      max_turns?: number;
      max_attempts?: number;
      status?: 'queued' | 'proposed';
      source?: 'manual' | 'planner';
      /** Links the task starts with; the caller has checked them (a new task can't make a cycle). */
      links?: { on: TaskId; kind: LinkKind }[];
      /** The task whose plan this one follows. */
      plan_task?: TaskId | null;
      plan_steps?: string[] | null;
      /** A plan for the new task to own and follow (the caller has parsed it): stored under its numbered name, and linked. */
      own_plan?: string;
    }): Task {
      const status = n.status ?? 'queued';
      const id = atomically(db, () => {
        const info = orm
          .insert(tasks)
          .values({
            repo_id: n.repo_id,
            title: n.title,
            prompt: n.prompt,
            priority: n.priority ?? 0,
            model: n.model ?? DEFAULT_MODEL,
            max_turns: n.max_turns ?? DEFAULTS.maxTurns,
            max_attempts: n.max_attempts ?? DEFAULTS.maxAttempts,
            status,
            source: n.source ?? 'manual',
            plan_task: n.plan_task ?? null,
            plan_steps: stored({ plan_steps: n.plan_steps ?? null }).plan_steps,
          })
          .run();
        const id = asTaskId(Number(info.lastInsertRowid));
        if (n.own_plan !== undefined) {
          insertOwnPlan(orm, id, n.own_plan, 'attached');
          orm.update(tasks).set({ plan_task: id }).where(eq(tasks.id, id)).run();
        }
        insertLinks(orm, id, n.links ?? []);
        recordEvent(orm, id, 'created', null, status);
        return id;
      });
      return getTask(id)!;
    },
    /**
     * Leave an unblock run's question on a blocked task, with an `unblock_ask` history row whose
     * reason is the question. Guarded like every task write: only a blocked task, so a retry or a cancel made while the
     * run went is never undone. Returns false if the task was not blocked.
     */
    recordQuestion(id: TaskId, question: UnblockQuestion, reason: string): boolean {
      return atomically(db, () => {
        const res = orm
          .update(tasks)
          .set({ ...columns(questionChanges(question)), updated_at: NOW_SQL })
          .where(and(eq(tasks.id, id), eq(tasks.status, 'blocked')))
          .run();
        if (!Number(res.changes)) return false;
        recordEvent(orm, id, 'unblock_ask', 'blocked', 'blocked', reason);
        return true;
      });
    },
    /**
     * Change a task's editable fields. Guarded by status like every other task write: only a task
     * in EDITABLE_STATUSES can be edited. Returns the task, or undefined if it is missing or in another status.
     * `ownPlan` (a parsed plan's HTML) becomes the task's own plan in the same write, only when the edit went through,
     * and the edit names `plan`.
     */
    editTask(
      id: TaskId,
      fields: Partial<Pick<Task, 'title' | 'prompt' | 'priority' | 'model' | 'max_turns' | 'max_attempts'>> & {
        plan_task?: TaskId | null;
        plan_steps?: string[] | null;
      },
      opts: { ownPlan?: string } = {},
    ): Task | undefined {
      if (Object.keys(fields).length === 0 && opts.ownPlan === undefined) return getTask(id);
      return atomically(db, () => {
        const edited = mapFound(
          orm
            .update(tasks)
            .set({ ...given(stored(fields)), updated_at: NOW_SQL })
            .where(and(eq(tasks.id, id), inArray(tasks.status, EDITABLE_STATUSES)))
            .returning(TASK_COLUMNS)
            .get(),
          toTask,
        );
        if (!edited) return undefined;
        if (opts.ownPlan !== undefined) saveOwnPlan(db, orm, id, opts.ownPlan, 'attached');
        // The status stays; the row says what was edited, and `stats` counts an edit of a queued or blocked task.
        const what = [...Object.keys(fields), ...(opts.ownPlan !== undefined ? ['plan'] : [])].join(', ');
        recordEvent(orm, id, 'edit', edited.status, edited.status, what);
        return edited;
      });
    },
    /**
     * Attach or replace a task's own plan (a parsed plan's HTML) and record it as an `edit` naming `plan`, so a cut-off
     * session of the task or of a task following the plan starts afresh (`editsSinceCutOff`). Guarded: only a task in
     * PLAN_ATTACHABLE_STATUSES. Returns the stored plan, or undefined if the task is missing or in another status.
     */
    attachOwnPlan(id: TaskId, html: string): TaskPlan | undefined {
      return atomically(db, () => {
        const row = orm
          .update(tasks)
          .set({ updated_at: NOW_SQL })
          .where(and(eq(tasks.id, id), inArray(tasks.status, PLAN_ATTACHABLE_STATUSES)))
          .returning({ status: tasks.status })
          .get() as { status: TaskStatus } | undefined;
        if (!row) return undefined;
        const saved = saveOwnPlan(db, orm, id, html, 'attached');
        recordEvent(orm, id, 'edit', row.status, row.status, 'plan');
        return saved;
      });
    },
    /** Where a task's work is checked out. Not a status, so unguarded. */
    setCheckout(id: TaskId, fields: { branch?: string | null; worktree?: string | null }): void {
      if (Object.keys(fields).length === 0) return;
      orm
        .update(tasks)
        .set({ ...given(fields), updated_at: NOW_SQL })
        .where(eq(tasks.id, id))
        .run();
    },
    /** Mark a sync of the task's branch as running (`syncing_since`), or clear the mark. Not a status, so unguarded. */
    setSyncing(id: TaskId, on: boolean): void {
      orm
        .update(tasks)
        .set({ syncing_since: on ? NOW_SQL : null })
        .where(eq(tasks.id, id))
        .run();
    },
    /**
     * Record a sync that changed a task's branch: a history row, no status change.
     * Guarded like every task write: only a running or done task. Returns false if it was not.
     */
    recordSync(id: TaskId, reason: string): boolean {
      return noteEvent(id, ['running', 'done'], 'sync', reason);
    },
    /**
     * Record that a run left linked plan steps unfinished: a history row, no status change. Only a running task.
     */
    recordPlanUnfinished(id: TaskId, reason: string): boolean {
      return noteEvent(id, ['running'], 'plan_unfinished', reason);
    },
    /**
     * Change the model a task's next attempt runs on, with a history row, together: an `escalate` row saying why
     * (domain/runs/escalate.ts), or an `edit` naming `model` for the one a person's retry names. Guarded on the model it moves
     * from, so an escalation is made once and a change made meanwhile wins, and on `statuses`. Returns false if it was not.
     */
    changeModel(
      id: TaskId,
      change: { from: string; to: string },
      row: { type: 'escalate'; reason: string } | { type: 'edit' },
      statuses: TaskStatus[],
    ): boolean {
      return atomically(db, () => {
        const updated = orm
          .update(tasks)
          .set({ ...columns(modelChanges(change.to)), updated_at: NOW_SQL })
          .where(and(eq(tasks.id, id), eq(tasks.model, change.from), inArray(tasks.status, statuses)))
          .returning({ status: tasks.status })
          .get() as { status: TaskStatus } | undefined;
        if (!updated) return false;
        recordEvent(orm, id, row.type, updated.status, updated.status, row.type === 'escalate' ? row.reason : 'model');
        return true;
      });
    },
  };
}
