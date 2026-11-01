// Task runs: one row per worker claude process.
import { and, asc, count, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Run, RunKind } from '../domain/run/run.ts';
import type { Orm } from './orm.ts';
import { NOW } from './sql.ts';
import { plannerRuns, runs } from './tables.ts';

export function runStore(orm: Orm) {
  return {
    startRun(task_id: number, attempt: number, log_path: string, kind: RunKind = 'work'): number {
      return Number(orm.insert(runs).values({ task_id, attempt, log_path, kind }).run().lastInsertRowid);
    },
    setRunPid(id: number, pid: number): void {
      orm.update(runs).set({ pid }).where(eq(runs.id, id)).run();
    },
    finishRun(id: number, r: Partial<Omit<Run, 'id' | 'task_id' | 'kind' | 'attempt' | 'started_at' | 'log_path'>>): void {
      // undefined means "not given" to Drizzle, but this has always written a given-as-undefined key as NULL.
      const given = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v ?? null]));
      orm
        .update(runs)
        .set({ ...given, ended_at: sql.raw(NOW) })
        .where(eq(runs.id, id))
        .run();
    },
    runsForTask(task_id: number): Run[] {
      return orm.select().from(runs).where(eq(runs.task_id, task_id)).orderBy(asc(runs.id)).all() as Run[];
    },
    /** Resolve runs still going, in any daemon process. */
    countRunningResolves(): number {
      return (
        orm
          .select({ n: count() })
          .from(runs)
          .where(and(eq(runs.kind, 'resolve'), isNull(runs.ended_at)))
          .get()?.n ?? 0
      );
    },
    /**
     * Slots in use, counted from the db so every process sees the same number: a task that is running (or being
     * cancelled), a task not running that has an unfinished resolve run (a task whose sync started one counts once),
     * and an unfinished planner run. A clean sync runs no claude and takes none.
     */
    slotsUsed(): number {
      const row = orm.get<{ n: number }>(sql`SELECT
             (SELECT COUNT(*) FROM tasks WHERE status IN ('running', 'cancel_requested'))
             + (SELECT COUNT(*) FROM tasks t WHERE t.status NOT IN ('running', 'cancel_requested')
                  AND EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND r.kind = 'resolve' AND r.ended_at IS NULL))
             + (SELECT COUNT(*) FROM planner_runs WHERE ended_at IS NULL) AS n`);
      return Number(row?.n ?? 0);
    },
    /** Whether a resolve run of this task has not finished. */
    hasRunningResolve(task_id: number): boolean {
      return (
        orm
          .select({ id: runs.id })
          .from(runs)
          .where(and(eq(runs.task_id, task_id), eq(runs.kind, 'resolve'), isNull(runs.ended_at)))
          .limit(1)
          .get() !== undefined
      );
    },
    /** Claude processes recorded on runs that never finished: a previous daemon died mid-run. */
    unfinishedPids(): { pid: number; started_at: string }[] {
      const unfinished = (t: typeof runs | typeof plannerRuns) => and(isNull(t.ended_at), isNotNull(t.pid));
      return orm
        .select({ pid: runs.pid, started_at: runs.started_at })
        .from(runs)
        .where(unfinished(runs))
        .unionAll(orm.select({ pid: plannerRuns.pid, started_at: plannerRuns.started_at }).from(plannerRuns).where(unfinished(plannerRuns)))
        .all() as { pid: number; started_at: string }[];
    },
  };
}
