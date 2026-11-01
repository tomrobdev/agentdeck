// The read behind `agentdeck stats`: work runs with their task's repo and status.
import { and, asc, eq } from 'drizzle-orm';
import type { StatRun } from '../domain/run/stats.ts';
import type { Orm } from './orm.ts';
import { runs, tasks } from './tables.ts';

export function statsStore(orm: Orm) {
  return {
    /** Every work run (resolve runs use no attempt), optionally of one repo, oldest first. */
    statRuns(repo_id?: number): StatRun[] {
      return orm
        .select({
          repo_id: tasks.repo_id,
          task_id: runs.task_id,
          attempt: runs.attempt,
          outcome: runs.outcome,
          started_at: runs.started_at,
          ended_at: runs.ended_at,
          cost_usd: runs.cost_usd,
          denials: runs.denials,
          task_status: tasks.status,
        })
        .from(runs)
        .innerJoin(tasks, eq(tasks.id, runs.task_id))
        .where(and(eq(runs.kind, 'work'), repo_id === undefined ? undefined : eq(tasks.repo_id, repo_id)))
        .orderBy(asc(runs.id))
        .all();
    },
  };
}
