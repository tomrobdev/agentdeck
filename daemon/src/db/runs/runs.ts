// Task runs: one row per worker claude process.
import { and, asc, count, countDistinct, eq, gt, inArray, isNotNull, isNull, max, notInArray, or, sql } from 'drizzle-orm';
import { type PlannerRunId, type RunId, type TaskId, stored } from '#domain/shared/index.ts';
import type { PidRun, Run, RunKind, RunningTaskRun } from '#domain/runs/index.ts';
import { RUNNING_STATUSES } from '#domain/work/index.ts';
import { toRun } from '#db/mappers.ts';
import type { Orm } from '#db/orm.ts';
import { NOW_SQL } from '#db/sql.ts';
import { plannerRuns, runs, tasks } from '#db/tables.ts';

const SIDE_KINDS: RunKind[] = ['resolve', 'unblock', 'review', 'verify', 'plan_resolve'];

export function runStore(orm: Orm) {
  const runningOf = (...kinds: RunKind[]) =>
    orm
      .select({ n: count() })
      .from(runs)
      .where(and(inArray(runs.kind, kinds), isNull(runs.ended_at)))
      .get()?.n ?? 0;
  return {
    startRun(
      task_id: TaskId,
      attempt: number,
      log_path: string,
      kind: RunKind = 'work',
      model: string | null = null,
      diff_hash: string | null = null,
    ): RunId {
      return Number(orm.insert(runs).values({ task_id, attempt, log_path, kind, model, diff_hash }).run().lastInsertRowid) as RunId;
    },
    setRunModelId(id: RunId, model_id: string): void {
      orm.update(runs).set({ model_id }).where(eq(runs.id, id)).run();
    },
    setRunPid(id: RunId, pid: number): void {
      orm.update(runs).set({ pid, pid_at: NOW_SQL }).where(eq(runs.id, id)).run();
    },
    setRunLive(id: RunId, live_turns: number, live_tool: string | null): void {
      orm.update(runs).set({ live_turns, live_tool }).where(eq(runs.id, id)).run();
    },
    setRunSession(id: RunId, session_id: string): void {
      orm.update(runs).set({ session_id }).where(eq(runs.id, id)).run();
    },
    liveRuns(kind: RunKind): Map<TaskId, { started_at: string; live_turns: number; live_tool: string | null }> {
      const rows = orm
        .select({ task_id: runs.task_id, started_at: runs.started_at, live_turns: runs.live_turns, live_tool: runs.live_tool })
        .from(runs)
        .where(and(eq(runs.kind, kind), isNull(runs.ended_at)))
        .orderBy(asc(runs.id))
        .all();
      return new Map(rows.map((r) => [r.task_id, r]));
    },
    latestRunModels(): Map<TaskId, string> {
      const rows = orm
        .select({ task_id: runs.task_id, model: runs.model })
        .from(runs)
        .where(
          and(
            eq(runs.kind, 'work'),
            inArray(
              runs.id,
              orm
                .select({ id: max(runs.id) })
                .from(runs)
                .where(eq(runs.kind, 'work'))
                .groupBy(runs.task_id),
            ),
          ),
        )
        .all();
      return new Map(rows.flatMap((r) => (r.model ? [[r.task_id, r.model] as const] : [])));
    },
    finishRun(id: RunId, r: Partial<Omit<Run, 'id' | 'task_id' | 'kind' | 'attempt' | 'started_at' | 'log_path' | 'model'>>): void {
      const given = Object.fromEntries(Object.entries(stored(r)).map(([k, v]) => [k, v ?? null]));
      orm
        .update(runs)
        .set({ ...given, ended_at: NOW_SQL })
        .where(eq(runs.id, id))
        .run();
    },
    runsForTask(task_id: TaskId): Run[] {
      return orm.select().from(runs).where(eq(runs.task_id, task_id)).orderBy(asc(runs.id)).all().map(toRun);
    },
    countRunningResolves(): number {
      return runningOf('resolve', 'plan_resolve');
    },
    countRunningUnblocks(): number {
      return runningOf('unblock');
    },
    countRunningReviews(): number {
      return runningOf('review');
    },
    countRunningVerifies(): number {
      return runningOf('verify');
    },
    slotsUsed(): number {
      const running = orm.select({ n: count() }).from(tasks).where(inArray(tasks.status, RUNNING_STATUSES)).get()?.n ?? 0;
      const beside =
        orm
          .select({ n: countDistinct(runs.task_id) })
          .from(runs)
          .innerJoin(tasks, eq(tasks.id, runs.task_id))
          .where(and(inArray(runs.kind, SIDE_KINDS), isNull(runs.ended_at), notInArray(tasks.status, RUNNING_STATUSES)))
          .get()?.n ?? 0;
      const planning = orm.select({ n: count() }).from(plannerRuns).where(isNull(plannerRuns.ended_at)).get()?.n ?? 0;
      return running + beside + planning;
    },
    hasRunningResolve(task_id: TaskId): boolean {
      return (
        orm
          .select({ id: runs.id })
          .from(runs)
          .where(and(eq(runs.task_id, task_id), eq(runs.kind, 'resolve'), isNull(runs.ended_at)))
          .limit(1)
          .get() !== undefined
      );
    },
    pidRuns(days: number): PidRun[] {
      // guard: the builder has no date arithmetic; this is the clock `days` ago, in the format timestamps are stored in
      const since = sql`datetime('now', ${`-${Math.floor(days)} days`})`;
      const recent = (t: typeof runs | typeof plannerRuns) => and(isNotNull(t.pid), or(isNull(t.ended_at), gt(t.ended_at, since)));
      const rows = orm
        .select({
          // guard: the union's column needs the planner side's kind type and an alias, which a plain column reference lacks
          kind: sql<PidRun['kind']>`${runs.kind}`.as('kind'),
          id: runs.id,
          pid: runs.pid,
          // guard: the builder has no COALESCE; a run whose pid time was never stored started with its pid
          pid_at: sql<string>`COALESCE(${runs.pid_at}, ${runs.started_at})`.as('pid_at'),
          ended_at: runs.ended_at,
        })
        .from(runs)
        .where(recent(runs))
        .unionAll(
          orm
            .select({
              // guard: the builder has no literal column; every row of this side is a planner run
              kind: sql<PidRun['kind']>`'planner'`.as('kind'),
              id: plannerRuns.id as unknown as typeof runs.id,
              pid: plannerRuns.pid,
              // guard: the union's column needs the same alias and string type as the runs side
              pid_at: sql<string>`${plannerRuns.started_at}`.as('pid_at'),
              ended_at: plannerRuns.ended_at,
            })
            .from(plannerRuns)
            .where(recent(plannerRuns)),
        )
        .all();
      return rows.flatMap((r) => (r.pid === null ? [] : [{ ...r, pid: r.pid }]));
    },
    runningTaskRuns(): RunningTaskRun[] {
      const open = orm
        .select({ task_id: runs.task_id, pid: runs.pid, pid_at: runs.pid_at, started_at: runs.started_at })
        .from(runs)
        .where(and(eq(runs.kind, 'work'), isNull(runs.ended_at)))
        .orderBy(asc(runs.id))
        .all();
      const unfinished = new Map(open.map((r) => [r.task_id, r]));
      return orm
        .select({ id: tasks.id })
        .from(tasks)
        .where(inArray(tasks.status, RUNNING_STATUSES))
        .orderBy(asc(tasks.id))
        .all()
        .map(({ id }) => {
          const r = unfinished.get(id);
          return { id, pid: r?.pid ?? null, pid_at: r ? (r.pid_at ?? r.started_at) : null, started_at: r?.started_at ?? null };
        });
    },
    unfinishedPids(): { pid: number; pid_at: string }[] {
      const unfinished = (t: typeof runs | typeof plannerRuns) => and(isNull(t.ended_at), isNotNull(t.pid));
      return (
        orm
          // guard: the builder has no COALESCE; a run whose pid time was never stored started with its pid
          .select({ pid: runs.pid, pid_at: sql<string>`COALESCE(${runs.pid_at}, ${runs.started_at})`.as('pid_at') })
          .from(runs)
          .where(unfinished(runs))
          .unionAll(
            orm
              // guard: the union's column needs the same alias and string type as the runs side
              .select({ pid: plannerRuns.pid, pid_at: sql<string>`${plannerRuns.started_at}`.as('pid_at') })
              .from(plannerRuns)
              .where(unfinished(plannerRuns)),
          )
          .all() as { pid: number; pid_at: string }[]
      );
    },
  };
}
