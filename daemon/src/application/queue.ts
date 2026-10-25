// Why queued tasks haven't started: what holds the whole queue, and what holds each task.
import type { Db } from '../db/index.ts';
import { dependencyOf } from './dependencies.ts';
import type { Repo } from '../domain/repo/repo.ts';
import { type QueueHold, type StartHold, queueHold, startHold } from '../domain/task/start.ts';
import type { Task } from '../domain/task/task.ts';
import { startGate } from './gate.ts';

export interface PausedRepo {
  id: number;
  name: string;
  reason: string;
  queued: number;
}

/** What holds the queue as a whole, and the repos that are paused (with how many queued tasks each holds back). */
export function queueHolds(db: Db): { hold: QueueHold | null; paused_repos: PausedRepo[] } {
  const queued = db.listTaskSummaries({ status: 'queued', limit: 1000 });
  return {
    hold: queueHold(startGate(db)),
    paused_repos: db
      .listRepos()
      .filter((r) => r.paused_reason)
      .map((r) => ({ id: r.id, name: r.name, reason: r.paused_reason!, queued: queued.filter((t) => t.repo_id === r.id).length })),
  };
}

/** A function telling why a task can't start yet. Make one per request: it reads the queue state once. */
export function startHolds(db: Db): (task: Pick<Task, 'status' | 'repo_id' | 'after_task'>) => StartHold | null {
  const q = startGate(db);
  const queue = queueHold(q);
  const running = db.countRunning();
  const repos = new Map<number, Repo>(db.listRepos().map((r) => [r.id, r]));
  return (task) =>
    startHold(task, {
      queue,
      repoPaused: repos.get(task.repo_id)?.paused_reason ?? null,
      dependency: dependencyOf(db, task),
      after: task.after_task,
      running,
      max: q.governor.max_concurrent,
    });
}
