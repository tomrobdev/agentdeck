// What queued tasks wait for: what stops the whole queue, and what each task waits for.
import type { Db } from '../../db/index.ts';
import type { RepoId } from '../../domain/shared/id.ts';
import type { Repo } from '../../domain/repos/repo.ts';
import type { StartState } from '../../domain/work/link.ts';
import { type QueueWait, type StartWait, startWait } from '../../domain/work/start.ts';
import type { Task } from '../../domain/work/task.ts';
import { queueWait } from '../capacity/gate.ts';

export interface PausedRepo {
  id: RepoId;
  name: string;
  reason: string;
  queued: number;
}

/** What the whole queue waits for, and the repos that are paused (with how many queued tasks each has waiting). */
export function queueWaits(db: Db): { wait: QueueWait | null; paused_repos: PausedRepo[] } {
  const queued = db.countQueuedByRepo();
  return {
    wait: queueWait(db).wait,
    paused_repos: db
      .listRepos()
      .filter((r) => r.paused_reason)
      .map((r) => ({ id: r.id, name: r.name, reason: r.paused_reason!, queued: queued.get(r.id) ?? 0 })),
  };
}

/**
 * A function telling what a task waits for, given its start state (application/task/dependencies.ts dependencyOf). Make
 * one per request: it reads the queue state once.
 */
export function startWaits(db: Db): (task: Pick<Task, 'status' | 'repo_id'>, dependency: StartState) => StartWait | null {
  const { wait: queue, used, max } = queueWait(db);
  const repos = new Map<RepoId, Repo>(db.listRepos().map((r) => [r.id, r]));
  return (task, dependency) =>
    startWait(task, { queue, repoPaused: repos.get(task.repo_id)?.paused_reason ?? null, dependency, running: used, max });
}
