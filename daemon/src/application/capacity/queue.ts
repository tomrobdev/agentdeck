// What queued tasks wait for: what stops the whole queue, and what each task waits for.
import type { App } from '../ports/app.ts';
import type { RepoId } from '../../domain/shared/index.ts';
import type { Repo } from '../../domain/repos/index.ts';
import type { StartState } from '../../domain/work/index.ts';
import { type QueueWait, type StartWait, startWait } from '../../domain/work/index.ts';
import type { Task } from '../../domain/work/index.ts';
import { queueWait } from './gate.ts';

export interface PausedRepo {
  id: RepoId;
  name: string;
  reason: string;
  queued: number;
}

/** What the whole queue waits for, and the repos that are paused (with how many queued tasks each has waiting). */
export function queueWaits(app: App): { wait: QueueWait | null; paused_repos: PausedRepo[] } {
  const queued = app.countQueuedByRepo();
  return {
    wait: queueWait(app).wait,
    paused_repos: app
      .listRepos()
      .filter((r) => r.paused_reason)
      .map((r) => ({ id: r.id, name: r.name, reason: r.paused_reason!, queued: queued.get(r.id) ?? 0 })),
  };
}

/**
 * A function telling what a task waits for, given its start state (application/task/dependencies.ts dependencyOf). Make
 * one per request: it reads the queue state once.
 */
export function startWaits(app: App): (task: Pick<Task, 'status' | 'repo_id'>, dependency: StartState) => StartWait | null {
  const { wait: queue, used, max } = queueWait(app);
  const repos = new Map<RepoId, Repo>(app.listRepos().map((r) => [r.id, r]));
  return (task, dependency) =>
    startWait(task, { queue, repoPaused: repos.get(task.repo_id)?.paused_reason ?? null, dependency, running: used, max });
}
