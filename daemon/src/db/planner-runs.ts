// Planner runs: one row per planner claude process.
import { count, desc, eq, isNull, sql } from 'drizzle-orm';
import type { PlannerRun } from '../domain/planner/proposals.ts';
import type { Orm } from './orm.ts';
import { NOW } from './sql.ts';
import { plannerRuns, repos } from './tables.ts';

export function plannerRunStore(orm: Orm) {
  return {
    startPlannerRun(repo_id: number, log_path: string): number {
      orm
        .update(repos)
        .set({ planned_at: sql.raw(NOW) })
        .where(eq(repos.id, repo_id))
        .run();
      return Number(orm.insert(plannerRuns).values({ repo_id, log_path }).run().lastInsertRowid);
    },
    setPlannerRunPid(id: number, pid: number): void {
      orm.update(plannerRuns).set({ pid }).where(eq(plannerRuns.id, id)).run();
    },
    finishPlannerRun(id: number, outcome: string, proposed: number, note: string | null): void {
      orm
        .update(plannerRuns)
        .set({ ended_at: sql.raw(NOW), outcome, proposed, note })
        .where(eq(plannerRuns.id, id))
        .run();
    },
    countRunningPlannerRuns(): number {
      return orm.select({ n: count() }).from(plannerRuns).where(isNull(plannerRuns.ended_at)).get()?.n ?? 0;
    },
    plannerRuns(repo_id?: number, limit = 10): PlannerRun[] {
      return orm
        .select()
        .from(plannerRuns)
        .where(repo_id ? eq(plannerRuns.repo_id, repo_id) : undefined)
        .orderBy(desc(plannerRuns.id))
        .limit(limit)
        .all();
    },
  };
}
