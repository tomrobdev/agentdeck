// Planner runs: one row per planner claude process.
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import type { PlannerRunId, RepoId } from '../domain/shared/id.ts';
import type { PlannerOutcome, PlannerRun } from '../domain/proposals/proposals.ts';
import type { Orm } from './orm.ts';
import { NOW_SQL } from './sql.ts';
import { plannerRuns, repos } from './tables.ts';

export function plannerRunStore(orm: Orm) {
  return {
    startPlannerRun(repo_id: RepoId, log_path: string): PlannerRunId {
      orm.update(repos).set({ proposed_at: NOW_SQL }).where(eq(repos.id, repo_id)).run();
      return Number(orm.insert(plannerRuns).values({ repo_id, log_path }).run().lastInsertRowid) as PlannerRunId;
    },
    setPlannerRunPid(id: PlannerRunId, pid: number): void {
      orm.update(plannerRuns).set({ pid }).where(eq(plannerRuns.id, id)).run();
    },
    finishPlannerRun(id: PlannerRunId, outcome: PlannerOutcome, proposed: number, note: string | null): void {
      orm
        .update(plannerRuns)
        .set({ ended_at: NOW_SQL, outcome, proposed, note })
        .where(and(eq(plannerRuns.id, id), isNull(plannerRuns.ended_at)))
        .run();
    },
    countRunningPlannerRuns(): number {
      return orm.select({ n: count() }).from(plannerRuns).where(isNull(plannerRuns.ended_at)).get()?.n ?? 0;
    },
    /** The planner runs under way, oldest first, with their repo's name. */
    unfinishedPlannerRuns(): { id: PlannerRunId; repo_id: RepoId; repo: string; started_at: string }[] {
      return orm
        .select({ id: plannerRuns.id, repo_id: plannerRuns.repo_id, repo: repos.name, started_at: plannerRuns.started_at })
        .from(plannerRuns)
        .innerJoin(repos, eq(repos.id, plannerRuns.repo_id))
        .where(isNull(plannerRuns.ended_at))
        .orderBy(plannerRuns.id)
        .all();
    },
    plannerRuns(repo_id?: RepoId, limit = 10): PlannerRun[] {
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
