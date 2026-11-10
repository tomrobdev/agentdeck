// Tasks: one store merged from its reads (tasks-queries.ts), its status changes (tasks-status.ts, every one through applyEvent, the claim included, guarded by the current status) and its PR writes (tasks-pr.ts), with the other writes here.
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
      model?: string;
      max_turns?: number;
      max_attempts?: number;
      status?: 'queued' | 'proposed';
      source?: 'manual' | 'planner';
      links?: { on: TaskId; kind: LinkKind }[];
      plan_task?: TaskId | null;
      plan_steps?: string[] | null;
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
        const what = [...Object.keys(fields), ...(opts.ownPlan !== undefined ? ['plan'] : [])].join(', ');
        recordEvent(orm, id, 'edit', edited.status, edited.status, what);
        return edited;
      });
    },
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
    setCheckout(id: TaskId, fields: { branch?: string | null; worktree?: string | null }): void {
      if (Object.keys(fields).length === 0) return;
      orm
        .update(tasks)
        .set({ ...given(fields), updated_at: NOW_SQL })
        .where(eq(tasks.id, id))
        .run();
    },
    setSyncing(id: TaskId, on: boolean): void {
      orm
        .update(tasks)
        .set({ syncing_since: on ? NOW_SQL : null })
        .where(eq(tasks.id, id))
        .run();
    },
    recordSync(id: TaskId, reason: string): boolean {
      return noteEvent(id, ['running', 'done'], 'sync', reason);
    },
    recordPlanUnfinished(id: TaskId, reason: string): boolean {
      return noteEvent(id, ['running'], 'plan_unfinished', reason);
    },
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
