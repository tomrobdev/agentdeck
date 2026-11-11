// Registered repos.
import { and, asc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { DatabaseSync } from 'node:sqlite';
import { type RepoId, type TaskId, asRepoId } from '../../domain/shared/index.ts';
import type { Repo } from '../../domain/repos/index.ts';
import { RUNNING_STATUSES } from '../../domain/work/index.ts';
import { mapFound, repoColumns, toRepo } from '../mappers.ts';
import type { Orm } from '../orm.ts';
import { NOW_SQL, atomically } from '../sql.ts';
import { notifications, plannerRuns, repos, reviewComments, reviews, runs, taskEvents, taskLinks, taskPlans, tasks } from '../tables.ts';

export function repoStore(db: DatabaseSync, orm: Orm) {
  const tasksOf = (repo_id: RepoId) => orm.select({ id: tasks.id }).from(tasks).where(eq(tasks.repo_id, repo_id));
  return {
    addRepo(r: {
      name: string;
      path: string;
      base_branch: string;
      test_cmd?: string | null;
      allowed_tools?: string[] | null;
      toolchain?: string | null;
      setup_cmd?: string | null;
    }): Repo {
      const info = orm
        .insert(repos)
        .values({
          name: r.name,
          path: r.path,
          base_branch: r.base_branch,
          test_cmd: r.test_cmd ?? null,
          ...repoColumns({ allowed_tools: r.allowed_tools?.length ? r.allowed_tools : null }),
          toolchain: r.toolchain ?? null,
          setup_cmd: r.setup_cmd ?? null,
        })
        .run();
      return this.getRepo(asRepoId(Number(info.lastInsertRowid)))!;
    },
    getRepo(id: RepoId): Repo | undefined {
      return mapFound(orm.select().from(repos).where(eq(repos.id, id)).get(), toRepo);
    },
    findRepo(nameOrId: string): Repo | undefined {
      return mapFound(
        orm
          .select()
          .from(repos)
          .where(or(eq(repos.name, nameOrId), eq(repos.id, /^\d+$/.test(nameOrId) ? asRepoId(Number(nameOrId)) : asRepoId(-1))))
          .get(),
        toRepo,
      );
    },
    listRepos(opts: { archived?: boolean } = {}): Repo[] {
      return orm
        .select()
        .from(repos)
        .where(opts.archived ? isNotNull(repos.archived_at) : isNull(repos.archived_at))
        .orderBy(asc(repos.name))
        .all()
        .map(toRepo);
    },
    setRepoArchived(id: RepoId, archived: boolean): void {
      orm
        .update(repos)
        .set({ archived_at: archived ? NOW_SQL : null })
        .where(eq(repos.id, id))
        .run();
    },
    repoHasRunning(id: RepoId): boolean {
      return !!orm
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.repo_id, id), inArray(tasks.status, RUNNING_STATUSES)))
        .limit(1)
        .get();
    },
    repoFootprint(id: RepoId): {
      tasks: { id: TaskId; branch: string | null; worktree: string | null }[];
      run_logs: string[];
      planner_logs: string[];
    } {
      return {
        tasks: orm
          .select({ id: tasks.id, branch: tasks.branch, worktree: tasks.worktree })
          .from(tasks)
          .where(eq(tasks.repo_id, id))
          .orderBy(asc(tasks.id))
          .all(),
        run_logs: orm
          .select({ log_path: runs.log_path })
          .from(runs)
          .where(inArray(runs.task_id, tasksOf(id)))
          .all()
          .map((r) => r.log_path),
        planner_logs: orm
          .select({ log_path: plannerRuns.log_path })
          .from(plannerRuns)
          .where(eq(plannerRuns.repo_id, id))
          .all()
          .map((r) => r.log_path),
      };
    },
    deleteRepo(id: RepoId): boolean {
      return atomically(db, () => {
        if (
          !orm
            .select({ id: repos.id })
            .from(repos)
            .where(and(eq(repos.id, id), isNotNull(repos.archived_at)))
            .get()
        )
          return false;
        orm
          .delete(taskEvents)
          .where(inArray(taskEvents.task_id, tasksOf(id)))
          .run();
        orm
          .delete(taskLinks)
          .where(or(inArray(taskLinks.task_id, tasksOf(id)), inArray(taskLinks.on_task, tasksOf(id))))
          .run();
        orm
          .delete(taskPlans)
          .where(inArray(taskPlans.task_id, tasksOf(id)))
          .run();
        const reviewsOf = orm
          .select({ id: reviews.id })
          .from(reviews)
          .where(inArray(reviews.task_id, tasksOf(id)));
        orm.delete(reviewComments).where(inArray(reviewComments.review_id, reviewsOf)).run();
        orm
          .delete(reviews)
          .where(inArray(reviews.task_id, tasksOf(id)))
          .run();
        orm
          .delete(runs)
          .where(inArray(runs.task_id, tasksOf(id)))
          .run();
        orm
          .delete(notifications)
          .where(inArray(notifications.task_id, tasksOf(id)))
          .run();
        orm.delete(tasks).where(eq(tasks.repo_id, id)).run();
        orm.delete(plannerRuns).where(eq(plannerRuns.repo_id, id)).run();
        orm.delete(repos).where(eq(repos.id, id)).run();
        return true;
      });
    },
    updateRepo(
      id: RepoId,
      fields: Partial<
        Pick<
          Repo,
          | 'auto_approve'
          | 'test_cmd'
          | 'setup_cmd'
          | 'proposed_at'
          | 'base_branch'
          | 'pr_mode'
          | 'merge_method'
          | 'auto_resolve'
          | 'auto_unblock'
          | 'escalate'
          | 'sandbox'
          | 'network'
          | 'auto_merge'
          | 'auto_merge_max_lines'
          | 'auto_merge_skip'
          | 'code_comment_max_lines'
          | 'code_comment_max_percent'
          | 'model'
          | 'allowed_tools'
        >
      >,
    ): void {
      if (!Object.keys(fields).length) return;
      orm.update(repos).set(repoColumns(fields)).where(eq(repos.id, id)).run();
    },
    setRepoPaused(id: RepoId, reason: string | null): void {
      orm.update(repos).set({ paused_reason: reason }).where(eq(repos.id, id)).run();
    },
    pauseRepo(id: RepoId, reason: string): boolean {
      const res = orm
        .update(repos)
        .set({ paused_reason: reason })
        .where(and(eq(repos.id, id), isNull(repos.paused_reason)))
        .run();
      return Number(res.changes) > 0;
    },
  };
}
