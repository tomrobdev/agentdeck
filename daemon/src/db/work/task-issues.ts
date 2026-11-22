// Task issues: the GitHub issue each issue-backed task came from, and what the daemon last reported on it.
import { and, asc, eq } from 'drizzle-orm';
import type { RepoId, TaskId } from '#domain/shared/index.ts';
import type { IssueReport, TaskIssue } from '#domain/work/index.ts';
import type { Orm } from '#db/orm.ts';
import { taskIssues } from '#db/tables.ts';

export function taskIssueStore(orm: Orm) {
  return {
    issueOf(id: TaskId): TaskIssue | undefined {
      return orm.select().from(taskIssues).where(eq(taskIssues.task_id, id)).get();
    },
    issuesOfRepo(repo_id: RepoId): TaskIssue[] {
      return orm.select().from(taskIssues).where(eq(taskIssues.repo_id, repo_id)).orderBy(asc(taskIssues.number)).all();
    },
    taskOfIssue(repo_id: RepoId, number: number): TaskId | undefined {
      return orm
        .select({ task_id: taskIssues.task_id })
        .from(taskIssues)
        .where(and(eq(taskIssues.repo_id, repo_id), eq(taskIssues.number, number)))
        .get()?.task_id;
    },
    reportIssue(id: TaskId, reported: IssueReport, at: string): void {
      orm.update(taskIssues).set({ reported, reported_at: at }).where(eq(taskIssues.task_id, id)).run();
    },
    unlinkIssue(id: TaskId): void {
      orm.delete(taskIssues).where(eq(taskIssues.task_id, id)).run();
    },
  };
}
