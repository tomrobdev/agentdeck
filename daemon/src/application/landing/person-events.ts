// Use cases for a person's lifecycle events: approve, reject, retry, cancel and mark done. Each goes through
// applyPersonEvent (settle.ts), which runs its follow-ups; they sit in landing/ beside it, which imports work/.
import type { App } from '../ports/app.ts';
import type { TaskId } from '../../domain/shared/index.ts';
import type { TaskStatus } from '../../domain/work/index.ts';
import { refuseWhileSyncing } from '../work/checkout-locks.ts';
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

/** Another attempt. A `note` ("request changes") is kept on the timeline and goes first in the next run's prompt. */
export function retryTask(app: App, id: TaskId, note?: string, onlyFrom?: TaskStatus[]): void {
  const t = requireTask(app, id);
  refuseWhileSyncing(app, id);
  if (note !== undefined && typeof note !== 'string') throw new ActionError('note must be text');
  // One more attempt on top of what has been used.
  if (!applyPersonEvent(app, id, { type: 'retry' }, { reason: note?.trim() || null, onlyFrom }))
    throw new ActionError(`#${id} is ${app.getTask(id)?.status ?? t.status}`);
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
