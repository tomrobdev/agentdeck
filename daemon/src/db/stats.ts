// The reads behind `agentdeck stats`: work runs with their task's repo and status, and tasks with their history.
import { and, asc, eq } from 'drizzle-orm';
import type { RepoId } from '../domain/shared/index.ts';
import type { ScorecardEvent, ScorecardTaskRow } from '../domain/insights/index.ts';
import type { StatRun } from '../domain/insights/index.ts';
import { readCounts } from './mappers.ts';
import type { Orm } from './orm.ts';
import { repos, runs, taskEvents, tasks } from './tables.ts';

export function statsStore(orm: Orm) {
  return {
    /** Every work run (resolve runs use no attempt), optionally of one repo, oldest first. */
    statRuns(repo_id?: RepoId): StatRun[] {
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
          model: runs.model,
          run_end: runs.run_end,
          last_test_failed: runs.last_test_failed,
        })
        .from(runs)
        .innerJoin(tasks, eq(tasks.id, runs.task_id))
        .where(and(eq(runs.kind, 'work'), repo_id === undefined ? undefined : eq(tasks.repo_id, repo_id)))
        .orderBy(asc(runs.id))
        .all()
        .map(({ last_test_failed, ...run }) => ({ ...run, last_test_failed: last_test_failed === null ? null : last_test_failed === 1 }));
    },
    /** Every task, optionally of one repo, with its own auto-merge setting and its repo's. */
    scorecardTasks(repo_id?: RepoId): ScorecardTaskRow[] {
      return orm
        .select({
          id: tasks.id,
          repo_id: tasks.repo_id,
          created_at: tasks.created_at,
          auto_merge: tasks.auto_merge,
          repo_auto_merge: repos.auto_merge,
          pr_checks_opened: tasks.pr_checks_opened,
          pr_checks_merged: tasks.pr_checks_merged,
        })
        .from(tasks)
        .innerJoin(repos, eq(repos.id, tasks.repo_id))
        .where(repo_id === undefined ? undefined : eq(tasks.repo_id, repo_id))
        .orderBy(asc(tasks.id))
        .all()
        .map(({ auto_merge, repo_auto_merge, pr_checks_opened, pr_checks_merged, ...task }) => ({
          ...task,
          pr_checks_opened: readCounts(pr_checks_opened),
          pr_checks_merged: readCounts(pr_checks_merged),
          auto_merge: auto_merge === null ? null : auto_merge === 1,
          repo_auto_merge: repo_auto_merge === 1,
        }));
    },
    /** Every history row of the tasks of one repo (or all), oldest first, with the task's repo. */
    scorecardEvents(repo_id?: RepoId): ScorecardEvent[] {
      return orm
        .select({
          task_id: taskEvents.task_id,
          repo_id: tasks.repo_id,
          type: taskEvents.type,
          from_status: taskEvents.from_status,
          to_status: taskEvents.to_status,
          reason: taskEvents.reason,
          at: taskEvents.at,
        })
        .from(taskEvents)
        .innerJoin(tasks, eq(tasks.id, taskEvents.task_id))
        .where(repo_id === undefined ? undefined : eq(tasks.repo_id, repo_id))
        .orderBy(asc(taskEvents.id))
        .all();
    },
  };
}
