// Tasks as the dashboard and the CLI show them: a task plus what the queue says about it.
import type { Db } from '../db/index.ts';
import type { StartWait } from '../domain/task/start.ts';
import type { TaskStatus } from '../domain/task/lifecycle.ts';
import type { Task } from '../domain/task/task.ts';
import { type Waiting, unblocksOf, waitingFor } from './dependencies.ts';
import { requireTask } from './input.ts';
import { startWaits } from './queue.ts';

/** What the queue says about one task, beyond the task row. */
export interface TaskView {
  repo: string | null;
  waiting: Waiting | null;
  unblocks: number[];
  plan_unfinished: boolean;
  wait: StartWait | null;
}

/** Each task with its view. Reads the repos, plans and queue state once for the whole list. */
export function withViews<T extends Pick<Task, 'id' | 'repo_id' | 'status' | 'after_task' | 'pr_state'>>(
  db: Db,
  tasks: T[],
): (T & TaskView)[] {
  const names = new Map(db.listRepos().map((r) => [r.id, r.name]));
  const waitOf = startWaits(db);
  const unfinished = db.planUnfinishedIds();
  return tasks.map((t) => ({
    ...t,
    repo: names.get(t.repo_id) ?? null,
    waiting: waitingFor(db, t),
    unblocks: unblocksOf(db, t),
    plan_unfinished: unfinished.has(t.id),
    wait: waitOf(t),
  }));
}

/** One task with its view, runs, events and plans. */
export function taskDetail(db: Db, id: number) {
  const task = requireTask(db, id);
  return {
    ...withViews(db, [task])[0],
    runs: db.runsForTask(id),
    events: db.eventsForTask(id),
    plans: db.plansForTask(id),
  };
}

/** Task summaries (no prompt), newest first, each with its view. */
export function taskViews(db: Db, filter: { status?: TaskStatus; limit: number; before?: number }) {
  return withViews(db, db.listTaskSummaries(filter));
}
