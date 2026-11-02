// Task runs: one row per worker claude process.
import { and, asc, count, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Run, RunKind } from '../domain/run/run.ts';
import type { Orm } from './orm.ts';
import { NOW } from './sql.ts';
import { plannerRuns, runs } from './tables.ts';

export interface PidRun {
  kind: 'work' | 'resolve' | 'planner';
  id: number;
  pid: number;
  /** When the pid was stored (the run's start for a row from before that was recorded). */
  pid_at: string;
  ended_at: string | null;
}

export interface RunningTaskRun {
  id: number;
  pid: number | null;
  pid_at: string | null;
  started_at: string | null;
}

export function runStore(orm: Orm) {
  return {
    startRun(task_id: number, attempt: number, log_path: string, kind: RunKind = 'work'): number {
      return Number(orm.insert(runs).values({ task_id, attempt, log_path, kind }).run().lastInsertRowid);
    },
    /** Record the run's claude process group, and when it started: what `ownsLiveGroup` checks the pid against. */
    setRunPid(id: number, pid: number): void {
      orm
        .update(runs)
        .set({ pid, pid_at: sql.raw(NOW) })
        .where(eq(runs.id, id))
        .run();
    },
    /** Record what a live run is doing; the write moves the change counter, which is what pushes it to the dashboard. */
    setRunLive(id: number, live_turns: number, live_tool: string | null): void {
      orm.update(runs).set({ live_turns, live_tool }).where(eq(runs.id, id)).run();
    },
    /** The claude session a run is in, stored as soon as claude names it so a run a restart ends can be resumed. */
    setRunSession(id: number, session_id: string): void {
      orm.update(runs).set({ session_id }).where(eq(runs.id, id)).run();
    },
    /** The unfinished work run of each task that has one, by task id: when it started and what it is doing. */
    liveRuns(): Map<number, { started_at: string; live_turns: number; live_tool: string | null }> {
      const rows = orm
        .select({ task_id: runs.task_id, started_at: runs.started_at, live_turns: runs.live_turns, live_tool: runs.live_tool })
        .from(runs)
        .where(and(eq(runs.kind, 'work'), isNull(runs.ended_at)))
        .orderBy(asc(runs.id))
        .all();
      return new Map(rows.map((r) => [r.task_id, r]));
    },
    /** The unfinished resolve run of each task that has one, by task id: when it started and what it is doing. */
    liveResolves(): Map<number, { started_at: string; live_turns: number; live_tool: string | null }> {
      const rows = orm
        .select({ task_id: runs.task_id, started_at: runs.started_at, live_turns: runs.live_turns, live_tool: runs.live_tool })
        .from(runs)
        .where(and(eq(runs.kind, 'resolve'), isNull(runs.ended_at)))
        .orderBy(asc(runs.id))
        .all();
      return new Map(rows.map((r) => [r.task_id, r]));
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
    /** Runs of any kind with a recorded pid that have not finished or finished within `days`: where a claude process may still be. */
    pidRuns(days: number): PidRun[] {
      const recent = (col: string) =>
        sql.raw(`pid IS NOT NULL AND (${col} IS NULL OR ${col} > datetime('now', '-${Math.floor(days)} days'))`);
      // A planner run starts its claude as it opens, so its started_at is when its pid was stored.
      return orm.all(sql`SELECT kind, id, pid, COALESCE(pid_at, started_at) AS pid_at, ended_at FROM runs WHERE ${recent('ended_at')}
        UNION ALL SELECT 'planner' AS kind, id, pid, started_at AS pid_at, ended_at FROM planner_runs WHERE ${recent('ended_at')}`) as PidRun[];
    },
    /** Tasks in running or being cancelled, each with its unfinished work run, if it has one: its pid, when that was stored, and its start. */
    runningTaskRuns(): RunningTaskRun[] {
      return orm.all(sql`SELECT t.id AS id, r.pid AS pid, COALESCE(r.pid_at, r.started_at) AS pid_at, r.started_at AS started_at
        FROM tasks t
        LEFT JOIN runs r ON r.id = (SELECT MAX(id) FROM runs WHERE task_id = t.id AND kind = 'work' AND ended_at IS NULL)
        WHERE t.status IN ('running', 'cancel_requested') ORDER BY t.id`) as RunningTaskRun[];
    },
    /** Claude processes recorded on runs that never finished: a previous daemon died mid-run. */
    unfinishedPids(): { pid: number; pid_at: string }[] {
      const unfinished = (t: typeof runs | typeof plannerRuns) => and(isNull(t.ended_at), isNotNull(t.pid));
      return orm
        .select({ pid: runs.pid, pid_at: sql<string>`COALESCE(${runs.pid_at}, ${runs.started_at})`.as('pid_at') })
        .from(runs)
        .where(unfinished(runs))
        .unionAll(
          orm
            .select({ pid: plannerRuns.pid, pid_at: sql<string>`${plannerRuns.started_at}`.as('pid_at') })
            .from(plannerRuns)
            .where(unfinished(plannerRuns)),
        )
        .all() as { pid: number; pid_at: string }[];
    },
  };
}
