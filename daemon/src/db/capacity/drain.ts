// What a drain waits for: the runs not yet ended, the retries still to start and the planner runs, in the daemon or one repo.
import { and, count, eq, exists, inArray, isNull, ne } from 'drizzle-orm';
import type { RepoId, TaskId } from '#domain/shared/index.ts';
import { RUNNING_STATUSES } from '#domain/work/index.ts';
import type { Orm } from '#db/orm.ts';
import { plannerRuns, repos, runs, tasks } from '#db/tables.ts';

export function drainStore(orm: Orm) {
  const hasWorkRun = () =>
    exists(
      orm
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.task_id, tasks.id), eq(runs.kind, 'work'))),
    );
  const movingRepos = () =>
    orm
      .select({ id: repos.id })
      .from(repos)
      .where(and(isNull(repos.paused_reason), isNull(repos.archived_at)));
  return {
    inFlightCounts(repo: RepoId | null): { runs: number; retries: number; planner: number } {
      const ofRepo = repo === null ? undefined : eq(tasks.repo_id, repo);
      const tasksOfRepo = orm.select({ id: tasks.id }).from(tasks).where(ofRepo);
      const running =
        orm
          .select({ n: count() })
          .from(tasks)
          .where(and(ofRepo, inArray(tasks.status, RUNNING_STATUSES)))
          .get()?.n ?? 0;
      const beside =
        orm
          .select({ n: count() })
          .from(runs)
          .where(and(isNull(runs.ended_at), ne(runs.kind, 'work'), repo === null ? undefined : inArray(runs.task_id, tasksOfRepo)))
          .get()?.n ?? 0;
      const retries =
        orm
          .select({ n: count() })
          .from(tasks)
          .where(and(ofRepo, eq(tasks.status, 'queued'), inArray(tasks.repo_id, movingRepos()), hasWorkRun()))
          .get()?.n ?? 0;
      const planner =
        orm
          .select({ n: count() })
          .from(plannerRuns)
          .where(and(isNull(plannerRuns.ended_at), repo === null ? undefined : eq(plannerRuns.repo_id, repo)))
          .get()?.n ?? 0;
      return { runs: running + beside, retries, planner };
    },
    queuedThatRan(): Set<TaskId> {
      const rows = orm
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.status, 'queued'), hasWorkRun()))
        .all();
      return new Set(rows.map((r) => r.id));
    },
  };
}
