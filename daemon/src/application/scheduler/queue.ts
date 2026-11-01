// What queued tasks wait for: what holds the whole queue, and what each task waits for.
import type { Db } from '../../db/index.ts';
import { dependencyOf } from '../task/dependencies.ts';
import type { Repo } from '../../domain/repo/repo.ts';
import { type QueueWait, type StartWait, startDecision, startWait } from '../../domain/task/start.ts';
import type { Task } from '../../domain/task/task.ts';
import { startGate } from './gate.ts';

export interface PausedRepo {
  id: number;
  name: string;
  reason: string;
  queued: number;
}

/** What the whole queue waits for, and the repos that are paused (with how many queued tasks each holds back). */
export function queueWaits(db: Db): { wait: QueueWait | null; paused_repos: PausedRepo[] } {
  const queued = db.listTaskSummaries({ status: 'queued', limit: 1000 });
  return {
    wait: startDecision(startGate(db), { ignorePause: false, used: db.slotsUsed(), now: Date.now() / 1000 }).wait,
    paused_repos: db
      .listRepos()
      .filter((r) => r.paused_reason)
      .map((r) => ({ id: r.id, name: r.name, reason: r.paused_reason!, queued: queued.filter((t) => t.repo_id === r.id).length })),
  };
}

/** A function telling what a task waits for. Make one per request: it reads the queue state once. */
export function startWaits(db: Db): (task: Pick<Task, 'id' | 'status' | 'repo_id'>) => StartWait | null {
  const q = startGate(db);
  const used = db.slotsUsed();
  const queue = startDecision(q, { ignorePause: false, used, now: Date.now() / 1000 }).wait;
  const repos = new Map<number, Repo>(db.listRepos().map((r) => [r.id, r]));
  return (task) =>
    startWait(task, {
      queue,
      repoPaused: repos.get(task.repo_id)?.paused_reason ?? null,
      dependency: dependencyOf(db, task),
      running: used,
      max: q.governor.max_concurrent,
    });
}
