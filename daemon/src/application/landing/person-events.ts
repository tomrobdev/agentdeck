// Use cases for a person's lifecycle events: approve, reject, retry, cancel and mark done. Each goes through
// applyPersonEvent (settle.ts), which leaves its follow-ups in the outbox for the daemon; they sit in landing/ beside it,
// which imports work/.
import type { App } from '../ports/app.ts';
import type { TaskId } from '../../domain/shared/index.ts';
import { type TaskStatus, fromStatuses, modelError } from '../../domain/work/index.ts';
import { refuseWhileSyncing } from '../work/checkout-locks.ts';
import { escalateOnRetry } from '../work/escalate.ts';
import { ActionError, requireTask } from '../shared/input.ts';
import { applyPersonEvent } from './settle.ts';

/** Returns 'cancelled' for idle tasks, 'stopping' when a running worker has been asked to stop. */
export function cancelTask(app: App, id: TaskId): 'cancelled' | 'stopping' {
  const t = applyPersonEvent(app, id, { type: 'cancel' });
  if (!t) throw new ActionError(`#${id} can't be cancelled from its current state`);
  return t.status === 'cancel_requested' ? 'stopping' : 'cancelled';
}

/** Accept a planner proposal into the queue. */
export function approveTask(app: App, id: TaskId): void {
  if (!applyPersonEvent(app, id, { type: 'approve' })) throw new ActionError(`#${id} is not a proposal`);
}

export function rejectTask(app: App, id: TaskId): void {
  if (!applyPersonEvent(app, id, { type: 'reject' })) throw new ActionError(`#${id} is not a proposal`);
}

/** What a person's retry says: a note for the next run, and the model it runs on. */
export interface RetryInput {
  note?: string;
  model?: string;
}

/**
 * Another attempt. A `note` ("request changes") is kept on the timeline and goes first in the next run's prompt. A `model`
 * is the one the attempt runs on, set as an edit; without one, a blocked or failed task whose last run failed in a way a
 * stronger model may fix runs one model up (`escalateOnRetry`). Returns the model the attempt runs on, and whether it was
 * moved up.
 */
export function retryTask(app: App, id: TaskId, input: RetryInput = {}, onlyFrom?: TaskStatus[]): { model: string; escalated: boolean } {
  const t = requireTask(app, id);
  refuseWhileSyncing(app, id);
  const { note, model } = input;
  if (note !== undefined && typeof note !== 'string') throw new ActionError('note must be text');
  if (model !== undefined && typeof model !== 'string') throw new ActionError('model must be text');
  const badModel = model === '' ? 'model must not be empty' : modelError(model);
  if (badModel) throw new ActionError(badModel);
  const from = fromStatuses({ type: 'retry' }).filter((s) => !onlyFrom || onlyFrom.includes(s));
  if (!from.includes(t.status)) throw new ActionError(`#${id} is ${t.status}`);
  // The model changes before the retry queues the task, so its next run starts on it.
  const escalated = model === undefined ? escalateOnRetry(app, t) : null;
  if (model !== undefined && model !== t.model && !app.changeModel(id, { from: t.model, to: model }, { type: 'edit' }, from))
    throw new ActionError(`#${id} changed meanwhile; try again`);
  // One more attempt on top of what has been used.
  const retried = applyPersonEvent(app, id, { type: 'retry' }, { reason: note?.trim() || null, onlyFrom });
  if (!retried) throw new ActionError(`#${id} is ${app.getTask(id)?.status ?? t.status}`);
  return { model: retried.model, escalated: escalated !== null };
}

/**
 * A person finished or landed a blocked or failed task's work themselves. The optional `note` goes on the timeline.
 * Done releases the tasks waiting on it (unless its PR is open: they wait for the merge), so it warns no one.
 */
export function markDone(app: App, id: TaskId, note?: string): void {
  const t = requireTask(app, id);
  if (note !== undefined && typeof note !== 'string') throw new ActionError('note must be text');
  if (!applyPersonEvent(app, id, { type: 'mark_done' }, { reason: note?.trim() || null }))
    throw new ActionError(`#${id} is ${app.getTask(id)?.status ?? t.status}; only blocked or failed tasks can be marked done`);
}
