// Use cases for tasks: add, edit, and move them through the lifecycle on a person's request.
import type { Db } from '../db/index.ts';
import { EDITABLE_STATUSES, type Task, defaultTitle } from '../domain/task/task.ts';
import { warnStuckDependents } from './dependencies.ts';
import { ActionError } from './errors.ts';
import { closePullRequest } from './pull-requests.ts';

export function addTask(
  db: Db,
  input: {
    repo?: string;
    prompt: string;
    title?: string;
    priority?: number;
    model?: string;
    max_turns?: number;
    max_attempts?: number;
    after_task?: number;
  },
): Task {
  const prompt = input.prompt?.trim();
  if (!prompt) throw new ActionError('a prompt is required');
  if (input.after_task !== undefined && (!Number.isInteger(input.after_task) || !db.getTask(input.after_task)))
    throw new ActionError(`--after: no task #${input.after_task}`);
  const repos = db.listRepos();
  const repo = input.repo ? db.findRepo(input.repo) : repos.length === 1 ? repos[0] : undefined;
  if (!repo) throw new ActionError(input.repo ? `no repo "${input.repo}"` : 'choose a repo (more than one is registered)');
  return db.addTask({
    repo_id: repo.id,
    title: input.title?.trim() || defaultTitle(prompt),
    prompt,
    priority: input.priority,
    model: input.model || undefined,
    max_turns: input.max_turns,
    max_attempts: input.max_attempts,
    after_task: input.after_task,
  });
}

/** Change a waiting or unsuccessful task's title, prompt, priority, model, turn limit or attempt limit. */
export function editTask(
  db: Db,
  id: number,
  patch: { title?: string; prompt?: string; priority?: number; model?: string; max_turns?: number; max_attempts?: number },
): Task {
  const task = db.getTask(id);
  if (!task) throw new ActionError('no such task');
  const fields: Parameters<Db['editTask']>[1] = {};

  const text = (key: 'title' | 'prompt' | 'model') => {
    const value = patch[key];
    if (value === undefined) return;
    if (typeof value !== 'string' || !value.trim()) throw new ActionError(`${key} cannot be empty`);
    fields[key] = value.trim();
  };
  const whole = (key: 'priority' | 'max_turns' | 'max_attempts', min: number, max: number) => {
    const value = patch[key];
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
      throw new ActionError(`${key} must be a whole number from ${min} to ${max}`);
    fields[key] = value;
  };
  text('title');
  text('prompt');
  text('model');
  whole('priority', -1000, 1000);
  whole('max_turns', 1, 500);
  whole('max_attempts', 1, 20);

  if (!Object.keys(fields).length) throw new ActionError('nothing to change');
  const edited = db.editTask(id, fields);
  if (!edited) {
    const now = db.getTask(id)?.status ?? task.status;
    throw new ActionError(`#${id} is ${now}; only ${EDITABLE_STATUSES.join(', ')} tasks can be edited`);
  }
  return edited;
}

/** Returns 'cancelled' for idle tasks, 'stopping' when a running worker has been asked to stop. */
export function cancelTask(db: Db, id: number): 'cancelled' | 'stopping' {
  const t = db.applyEvent(id, { type: 'cancel' });
  if (!t) throw new ActionError(`#${id} can't be cancelled from its current state`);
  warnStuckDependents(db, id);
  return t.status === 'cancel_requested' ? 'stopping' : 'cancelled';
}

/** Accept a planner proposal into the queue. */
export function approveTask(db: Db, id: number): void {
  if (!db.applyEvent(id, { type: 'approve' })) throw new ActionError(`#${id} is not a proposal`);
}

export function rejectTask(db: Db, id: number): void {
  if (!db.applyEvent(id, { type: 'reject' })) throw new ActionError(`#${id} is not a proposal`);
  warnStuckDependents(db, id);
}

/** Another attempt. A `note` ("request changes") is kept on the timeline and goes first in the next run's prompt. */
export function retryTask(db: Db, id: number, note?: string): void {
  const t = db.getTask(id);
  if (!t) throw new ActionError('no such task');
  if (note !== undefined && typeof note !== 'string') throw new ActionError('note must be text');
  // One more attempt on top of what has been used.
  if (!db.applyEvent(id, { type: 'retry' }, { reason: note?.trim() || null })) throw new ActionError(`#${id} is ${t.status}`);
}

/** Close a task's open PR without merging it. Tasks waiting on it become stuck. */
export async function closeTaskPr(db: Db, id: number): Promise<void> {
  const t = db.getTask(id);
  if (!t) throw new ActionError('no such task');
  if (!t.pr_url || t.pr_state !== 'open') throw new ActionError(`#${id} has no open pull request`);
  try {
    await closePullRequest(db, t);
  } catch (err) {
    throw new ActionError(`could not close the PR: ${(err as Error).message}`);
  }
}
