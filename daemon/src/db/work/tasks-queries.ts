// The reads of tasks: listings, counts, the attention list and the candidates for unblock and review runs.
import { type SQL, and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { RepoId, TaskId } from '../../domain/shared/index.ts';
import {
  type BlockedTask,
  OPEN_STATUSES,
  RUNNING_STATUSES,
  type Task,
  type TaskStatus,
  type TaskSummary,
  isBlocked,
} from '../../domain/work/index.ts';
import type { AttentionCandidate, AttentionWhy } from '../../domain/operations/index.ts';
import { SUMMARY_COLUMNS, TASK_COLUMNS, mapFound, toTask, toTaskSummary } from '../mappers.ts';
import type { Orm } from '../orm.ts';
import { inActiveRepo as inActiveRepoOf } from '../sql.ts';
import { repos, tasks } from '../tables.ts';
import { inReview, prOpen } from './tasks-columns.ts';

export function taskQueries(orm: Orm) {
  const inActiveRepo = (col: AnySQLiteColumn) => inActiveRepoOf(orm, col);
  const countWhere = (where: SQL | undefined) => orm.select({ n: count() }).from(tasks).where(where).get()?.n ?? 0;

  return {
    getTask(id: TaskId): Task | undefined {
      return mapFound(orm.select(TASK_COLUMNS).from(tasks).where(eq(tasks.id, id)).get(), toTask);
    },
    listTasks(): Task[] {
      return orm.select(TASK_COLUMNS).from(tasks).where(inActiveRepo(tasks.repo_id)).orderBy(desc(tasks.id)).all().map(toTask);
    },
    tasksForRepo(repo_id: RepoId, limit = 40): Task[] {
      return orm.select(TASK_COLUMNS).from(tasks).where(eq(tasks.repo_id, repo_id)).orderBy(desc(tasks.id)).limit(limit).all().map(toTask);
    },
    /** Tasks of a repo that still need work or a decision; the planner waits until there are none. */
    countOpen(repo_id: RepoId): number {
      return countWhere(and(eq(tasks.repo_id, repo_id), inArray(tasks.status, OPEN_STATUSES)));
    },
    countRunning(): number {
      return countWhere(inArray(tasks.status, RUNNING_STATUSES));
    },
    /** The tasks with a live run, oldest first: what a restart at once would requeue. */
    runningTasks(): { id: TaskId; title: string }[] {
      return orm
        .select({ id: tasks.id, title: tasks.title })
        .from(tasks)
        .where(inArray(tasks.status, RUNNING_STATUSES))
        .orderBy(asc(tasks.id))
        .all();
    },
    /** How many tasks are in each status (statuses with none are left out). */
    countByStatus(): Record<string, number> {
      const rows = orm
        .select({ status: tasks.status, n: count() })
        .from(tasks)
        .where(inActiveRepo(tasks.repo_id))
        .groupBy(tasks.status)
        .all();
      return Object.fromEntries(rows.map((r) => [r.status, r.n]));
    },
    /** How many queued tasks each repo has (repos with none are left out). */
    countQueuedByRepo(): Map<RepoId, number> {
      const rows = orm
        .select({ repo_id: tasks.repo_id, n: count() })
        .from(tasks)
        .where(and(eq(tasks.status, 'queued'), inActiveRepo(tasks.repo_id)))
        .groupBy(tasks.repo_id)
        .all();
      return new Map(rows.map((r) => [r.repo_id, r.n]));
    },
    /** Done tasks whose pull request is open: the ones waiting for a review. */
    countReview(): number {
      return countWhere(and(inReview, inActiveRepo(tasks.repo_id)));
    },
    /**
     * The tasks that wait on a person: blocked, in review, proposed, in active repos. One query: blocked first, then
     * review, then proposed, each by priority then id, at most `limit`.
     */
    attentionTasks(limit: number): AttentionCandidate[] {
      // guard: the builder has no CASE; one query orders blocked, review and proposed tasks and labels each
      const why = sql<AttentionWhy>`CASE WHEN ${tasks.status} = 'blocked' THEN 'blocked' WHEN ${tasks.status} = 'proposed' THEN 'proposed' ELSE 'review' END`;
      // guard: the builder has no CASE; this ranks the three kinds in the order they are listed
      const rank = sql`CASE WHEN ${tasks.status} = 'blocked' THEN 0 WHEN ${tasks.status} = 'done' THEN 1 ELSE 2 END`;
      return orm
        .select({ id: tasks.id, title: tasks.title, priority: tasks.priority, why })
        .from(tasks)
        .where(and(or(inArray(tasks.status, ['blocked', 'proposed']), inReview), inActiveRepo(tasks.repo_id)))
        .orderBy(rank, desc(tasks.priority), asc(tasks.id))
        .limit(limit)
        .all();
    },
    /**
     * Blocked tasks in repos that have auto_unblock on and may start work (not paused, not archived), by priority then
     * age: the ones an unblock run may be for. Whether one may start is `unblockable`'s to say.
     */
    unblockCandidates(): BlockedTask[] {
      const unblocking = orm
        .select({ id: repos.id })
        .from(repos)
        .where(and(eq(repos.auto_unblock, 1), isNull(repos.paused_reason), isNull(repos.archived_at)));
      return orm
        .select(TASK_COLUMNS)
        .from(tasks)
        .where(and(eq(tasks.status, 'blocked'), inArray(tasks.repo_id, unblocking)))
        .orderBy(desc(tasks.priority), asc(tasks.id))
        .all()
        .map(toTask)
        .filter(isBlocked);
    },
    /**
     * Done tasks with an open pull request in repos that have auto_review on and may start work (not paused, not
     * archived), by priority then age: the ones a review run may be for. Whether one may start is `reviewable`'s to say.
     */
    reviewCandidates(): Task[] {
      const reviewing = orm
        .select({ id: repos.id })
        .from(repos)
        .where(and(eq(repos.auto_review, 1), isNull(repos.paused_reason), isNull(repos.archived_at)));
      return orm
        .select(TASK_COLUMNS)
        .from(tasks)
        .where(and(eq(tasks.status, 'done'), eq(tasks.pr_state, 'open'), inArray(tasks.repo_id, reviewing)))
        .orderBy(desc(tasks.priority), asc(tasks.id))
        .all()
        .map(toTask);
    },
    /**
     * Tasks without their prompt, newest first. Returns the `limit` newest tasks older than `before`
     * (all tasks when omitted). On the first page (no `before`) every active task is included on top
     * of the limit, so views of in-flight work stay complete. Later pages hold older tasks only.
     */
    listTaskSummaries(opts: { status?: TaskStatus; limit: number; before?: TaskId }): TaskSummary[] {
      const { status, limit, before } = opts;
      const ofStatus = status === undefined ? undefined : eq(tasks.status, status);
      const page = orm
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(ofStatus, inActiveRepo(tasks.repo_id), before === undefined ? undefined : lt(tasks.id, before)))
        .orderBy(desc(tasks.id))
        .limit(limit);
      return orm
        .select(SUMMARY_COLUMNS)
        .from(tasks)
        .where(
          and(
            ofStatus,
            inActiveRepo(tasks.repo_id),
            or(inArray(tasks.id, page), before === undefined ? inArray(tasks.status, OPEN_STATUSES) : undefined),
          ),
        )
        .orderBy(desc(tasks.id))
        .all()
        .map(toTaskSummary);
    },
    /**
     * Tasks whose pull request is still open, for the state refresh: done ones, and blocked or failed ones
     * (a conflict blocks a done task and keeps its PR; a retry that fails keeps it too).
     */
    openPrTasks(): Task[] {
      return orm
        .select(TASK_COLUMNS)
        .from(tasks)
        .where(and(inArray(tasks.status, ['done', 'blocked', 'failed']), isNotNull(tasks.pr_url), prOpen, inActiveRepo(tasks.repo_id)))
        .all()
        .map(toTask);
    },
    /** Done tasks whose pull request failed to open, for the PR refresh to open again. */
    failedPrTasks(): Task[] {
      return orm
        .select(TASK_COLUMNS)
        .from(tasks)
        .where(and(eq(tasks.status, 'done'), eq(tasks.pr_state, 'failed'), inActiveRepo(tasks.repo_id)))
        .orderBy(asc(tasks.id))
        .all()
        .map(toTask);
    },
    /** Whether a sync of the task's branch is marked as running, by any process. */
    hasSyncMarker(id: TaskId): boolean {
      const row = orm.select({ since: tasks.syncing_since }).from(tasks).where(eq(tasks.id, id)).get();
      return row?.since != null;
    },
  };
}
