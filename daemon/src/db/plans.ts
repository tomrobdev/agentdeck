// Plans attached to tasks: the HTML as written, parsed into steps when read.
import { and, asc, eq, notInArray, sql } from 'drizzle-orm';
import { type PlanSource, type TaskPlan, parsePlan } from '../domain/plan/plan.ts';
import type { Orm } from './orm.ts';
import { NOW, atomically } from './sql.ts';
import { taskPlans } from './tables.ts';
import type { DatabaseSync } from 'node:sqlite';

type PlanRow = typeof taskPlans.$inferSelect;

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

  return {
    savePlan(task_id: number, name: string, source: PlanSource, html: string): void {
      upsert(task_id, name, source, html);
    },
    /** Make the task's branch plans exactly `plans`: upsert each, drop branch plans no longer there. */
    replaceBranchPlans(task_id: number, plans: { name: string; html: string }[]): void {
      atomically(db, () => {
        for (const p of plans) upsert(task_id, p.name, 'branch', p.html);
        const keep = plans.map((p) => p.name);
        orm
          .delete(taskPlans)
          .where(
            and(eq(taskPlans.task_id, task_id), eq(taskPlans.source, 'branch'), keep.length ? notInArray(taskPlans.name, keep) : undefined),
          )
          .run();
      });
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
