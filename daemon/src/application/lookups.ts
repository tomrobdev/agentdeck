// Finding a task or repo a person named, or saying why not. The one place these messages are worded.
import type { Db } from '../db/index.ts';
import type { Repo } from '../domain/repo/repo.ts';
import type { Task } from '../domain/task/task.ts';
import { ActionError } from './errors.ts';

export function requireTask(db: Db, id: number): Task {
  const task = db.getTask(id);
  if (!task) throw new ActionError('no such task');
  return task;
}

export function requireRepo(db: Db, nameOrId: string | number): Repo {
  const repo = db.findRepo(String(nameOrId));
  if (!repo) throw new ActionError(`no repo "${nameOrId}"`);
  return repo;
}

/** The repo a task belongs to. */
export function requireTaskRepo(db: Db, task: Task): Repo {
  const repo = db.getRepo(task.repo_id);
  if (!repo) throw new ActionError('the task has no repo');
  return repo;
}
