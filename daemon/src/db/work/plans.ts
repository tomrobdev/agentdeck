// Plans attached to tasks: the HTML as written, parsed into steps when read.
import { and, asc, desc, eq, ne, notInArray, sql } from 'drizzle-orm';
import type { TaskId } from '../../domain/shared/index.ts';
import { type OwnPlan, type PlanSource, type TaskPlan, parsePlan, planFileName, toPlan } from '../../domain/work/index.ts';
import type { PlanFollower } from '../../domain/work/index.ts';
import { readSteps } from '../mappers.ts';
import type { Orm } from '../orm.ts';
import { NOW_SQL, atomically } from '../sql.ts';
import { taskPlans, tasks } from '../tables.ts';
import type { DatabaseSync } from 'node:sqlite';

type PlanRow = typeof taskPlans.$inferSelect;

const asOwnPlan = (row: PlanRow): OwnPlan => ({ ...row, source: row.source as PlanSource });

/** Insert task `task_id`'s own plan under the name its title gives (planFileName). The caller makes sure it has none. */
export function insertOwnPlan(orm: Orm, task_id: TaskId, html: string, source: PlanSource): string {
  const name = planFileName(task_id, parsePlan(html)?.title ?? '');
  orm.insert(taskPlans).values({ task_id, name, source, html }).run();
  return name;
}

/**
 * The task's own plan, the newest if there were ever two: the row under its numbered name (planFileName). Plans stored
 * before plans had numbers are not its own.
 */
function ownPlanRow(orm: Orm, task_id: TaskId): OwnPlan | undefined {
  const row = orm
    .select()
    .from(taskPlans)
    .where(
      and(
        eq(taskPlans.task_id, task_id),
        // guard: the builder has no GLOB; a LIKE would treat `_` and `%` in a name as wildcards
        sql`${taskPlans.name} GLOB ${`${task_id}-*.html`}`,
        // guard: the builder has no GLOB or substr; the name between the number and `.html` has only a-z, 0-9 and `-`
        sql`substr(${taskPlans.name}, 1, length(${taskPlans.name}) - 5) NOT GLOB '*[^a-z0-9-]*'`,
      ),
    )
    .orderBy(desc(taskPlans.id))
    .get();
  return row && asOwnPlan(row);
}

/**
 * Store `html` (a plan) as the task's own plan, under the name its title gives (planFileName), replacing the plan it
 * had: that row keeps its id, so the dashboard's view of it follows. The task store calls it inside its guarded writes.
 */
export function saveOwnPlan(db: DatabaseSync, orm: Orm, task_id: TaskId, html: string, source: PlanSource): TaskPlan {
  const name = planFileName(task_id, parsePlan(html)?.title ?? '');
  return atomically(db, () => {
    const old = ownPlanRow(orm, task_id);
    if (!old) insertOwnPlan(orm, task_id, html, source);
    else {
      orm
        .delete(taskPlans)
        .where(and(eq(taskPlans.task_id, task_id), eq(taskPlans.name, name), ne(taskPlans.id, old.id)))
        .run();
      if (old.name !== name || old.html !== html || old.source !== source) {
        orm.update(taskPlans).set({ name, source, html, updated_at: NOW_SQL }).where(eq(taskPlans.id, old.id)).run();
      }
    }
    return toPlan(ownPlanRow(orm, task_id)!);
  });
}

export function planStore(db: DatabaseSync, orm: Orm) {
  return {
    ownPlan: (task_id: TaskId): OwnPlan | undefined => ownPlanRow(orm, task_id),
    /** Store a plan as the task's own (`saveOwnPlan`), unguarded: for a run's worker, whose task is running. */
    saveOwnPlan: (task_id: TaskId, html: string, source: PlanSource): TaskPlan => saveOwnPlan(db, orm, task_id, html, source),
    /** Replace a stored plan's HTML, keeping its name and source. updated_at moves only when the HTML changed. */
    updatePlanHtml(id: number, html: string): void {
      orm
        .update(taskPlans)
        .set({ html, updated_at: NOW_SQL })
        .where(and(eq(taskPlans.id, id), ne(taskPlans.html, html)))
        .run();
    },
    /** Whether a task other than `task_id` follows task `task_id`'s plan. */
    planShared(task_id: TaskId): boolean {
      return !!orm
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.plan_task, task_id), ne(tasks.id, task_id)))
        .get();
    },
    /**
     * The tasks that follow task `task_id`'s plan (itself too when it was given its plan with --plan) and may still run
     * on it: not done or cancelled. Oldest first, with their plan links.
     */
    planFollowers(task_id: TaskId): PlanFollower[] {
      return orm
        .select({ id: tasks.id, plan_steps: tasks.plan_steps })
        .from(tasks)
        .where(and(eq(tasks.plan_task, task_id), notInArray(tasks.status, ['done', 'cancelled'])))
        .orderBy(asc(tasks.id))
        .all()
        .map((f) => ({ id: f.id, plan: { task: task_id, steps: readSteps(f.plan_steps) } }));
    },
    /** The task's plans, oldest first, without their HTML. */
    plansForTask(task_id: TaskId): TaskPlan[] {
      return orm
        .select()
        .from(taskPlans)
        .where(eq(taskPlans.task_id, task_id))
        .orderBy(asc(taskPlans.id))
        .all()
        .map((row) => toPlan(asOwnPlan(row)));
    },
    planHtml(task_id: TaskId, id: number): string | undefined {
      return orm
        .select({ html: taskPlans.html })
        .from(taskPlans)
        .where(and(eq(taskPlans.task_id, task_id), eq(taskPlans.id, id)))
        .get()?.html;
    },
  };
}
