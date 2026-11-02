// Plans attached to tasks: the HTML as written, parsed into steps when read.
import { and, asc, eq, ne, notInArray, sql } from 'drizzle-orm';
import { type PlanSource, type TaskPlan, isOwnPlanName, parsePlan, planFileName } from '../domain/plan/plan.ts';
import type { Task } from '../domain/task/task.ts';
import type { Orm } from './orm.ts';
import { NOW, atomically } from './sql.ts';
import { taskPlans, tasks } from './tables.ts';
import type { DatabaseSync } from 'node:sqlite';

type PlanRow = typeof taskPlans.$inferSelect;

/** A task's own plan with its HTML: the one stored under the task's numbered name. */
export interface OwnPlan {
  id: number;
  task_id: number;
  name: string;
  source: PlanSource;
  html: string;
}

/** A row as the API shows it. A row that no longer parses (it always did when saved) reads as untitled. */
function toPlan({ html, ...row }: PlanRow): TaskPlan {
  return {
    ...row,
    source: row.source as PlanSource,
    ...(parsePlan(html) ?? { version: '1', title: 'Untitled plan', summary: null, steps: [] }),
  };
}

export function planStore(db: DatabaseSync, orm: Orm) {
  /** Insert or replace by name; updated_at moves only when the HTML changed. */
  const upsert = (task_id: number, name: string, source: PlanSource, html: string) =>
    orm
      .insert(taskPlans)
      .values({ task_id, name, source, html })
      .onConflictDoUpdate({
        target: [taskPlans.task_id, taskPlans.name],
        set: { source: sql`excluded.source`, html: sql`excluded.html`, updated_at: sql.raw(NOW) },
        setWhere: sql`${taskPlans.html} IS NOT excluded.html OR ${taskPlans.source} IS NOT excluded.source`,
      })
      .run();

  /** The task's own plan, the newest if there were ever two. Plans stored before plans had numbers are not its own. */
  const ownPlan = (task_id: number): OwnPlan | undefined =>
    orm
      .select({ id: taskPlans.id, task_id: taskPlans.task_id, name: taskPlans.name, source: taskPlans.source, html: taskPlans.html })
      .from(taskPlans)
      .where(eq(taskPlans.task_id, task_id))
      .orderBy(asc(taskPlans.id))
      .all()
      .filter((p) => isOwnPlanName(task_id, p.name))
      .map((p) => ({ ...p, source: p.source as PlanSource }))
      .at(-1);

  return {
    savePlan(task_id: number, name: string, source: PlanSource, html: string): void {
      upsert(task_id, name, source, html);
    },
    ownPlan,
    /**
     * Store `html` (a plan) as the task's own plan, under the name its title gives (planFileName), replacing the plan it
     * had: that row keeps its id, so the dashboard's view of it follows.
     */
    saveOwnPlan(task_id: number, html: string, source: PlanSource): TaskPlan {
      const name = planFileName(task_id, parsePlan(html)?.title ?? '');
      return atomically(db, () => {
        const old = ownPlan(task_id);
        if (!old) upsert(task_id, name, source, html);
        else {
          orm
            .delete(taskPlans)
            .where(and(eq(taskPlans.task_id, task_id), eq(taskPlans.name, name), ne(taskPlans.id, old.id)))
            .run();
          if (old.name !== name || old.html !== html || old.source !== source) {
            orm
              .update(taskPlans)
              .set({ name, source, html, updated_at: sql.raw(NOW) })
              .where(eq(taskPlans.id, old.id))
              .run();
          }
        }
        return toPlan(
          orm
            .select()
            .from(taskPlans)
            .where(and(eq(taskPlans.task_id, task_id), eq(taskPlans.name, name)))
            .get()!,
        );
      });
    },
    /** Replace a stored plan's HTML, keeping its name and source. updated_at moves only when the HTML changed. */
    updatePlanHtml(id: number, html: string): void {
      orm
        .update(taskPlans)
        .set({ html, updated_at: sql.raw(NOW) })
        .where(and(eq(taskPlans.id, id), sql`${taskPlans.html} IS NOT ${html}`))
        .run();
    },
    /** Whether a task other than `task_id` follows task `task_id`'s plan. */
    planShared(task_id: number): boolean {
      return !!orm
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.plan_task, task_id), ne(tasks.id, task_id)))
        .get();
    },
    /**
     * The tasks that follow task `task_id`'s plan (itself too when it was given its plan with --plan) and may still run
     * on it: not done or cancelled. Oldest first, with their `plan_steps`.
     */
    planFollowers(task_id: number): Pick<Task, 'id' | 'plan_steps'>[] {
      return orm
        .select({ id: tasks.id, plan_steps: tasks.plan_steps })
        .from(tasks)
        .where(and(eq(tasks.plan_task, task_id), notInArray(tasks.status, ['done', 'cancelled'])))
        .orderBy(asc(tasks.id))
        .all();
    },
    /** The task's plans, oldest first, without their HTML. */
    plansForTask(task_id: number): TaskPlan[] {
      return orm.select().from(taskPlans).where(eq(taskPlans.task_id, task_id)).orderBy(asc(taskPlans.id)).all().map(toPlan);
    },
    planHtml(task_id: number, id: number): string | undefined {
      return orm
        .select({ html: taskPlans.html })
        .from(taskPlans)
        .where(and(eq(taskPlans.task_id, task_id), eq(taskPlans.id, id)))
        .get()?.html;
    },
  };
}
