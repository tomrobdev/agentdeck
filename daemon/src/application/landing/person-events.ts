// Use cases for a person's lifecycle events: approve, reject, retry, cancel and mark done.
import type { App } from '#application/ports/app.ts';
import type { TaskId } from '#domain/shared/index.ts';
import { type TaskStatus, fromStatuses, maxTurnsError, modelError } from '#domain/work/index.ts';
import { refuseWhileSyncing } from '#application/work/checkout-locks.ts';
import { escalateOnRetry } from '#application/work/escalate.ts';
import { ActionError, requireTask } from '#application/shared/input.ts';
import { applyPersonEvent } from '#application/landing/settle.ts';

export function cancelTask(app: App, id: TaskId): 'cancelled' | 'stopping' {
  const t = applyPersonEvent(app, id, { type: 'cancel' });
  if (!t) throw new ActionError(`#${id} can't be cancelled from its current state`, undefined, 'conflict');
  return t.status === 'cancel_requested' ? 'stopping' : 'cancelled';
}

export function approveTask(app: App, id: TaskId): void {
  if (!applyPersonEvent(app, id, { type: 'approve' }))
    throw new ActionError(
      app.getTask(id)?.status === 'parked' ? `#${id} is parked; lift it before approving it` : `#${id} is not a proposal`,
      undefined,
      'conflict',
    );
}

export function rejectTask(app: App, id: TaskId): void {
  if (!applyPersonEvent(app, id, { type: 'reject' })) throw new ActionError(`#${id} is not a proposal`, undefined, 'conflict');
}

export function parkTask(app: App, id: TaskId, reason?: string): void {
  if (reason !== undefined && typeof reason !== 'string') throw new ActionError('reason must be text');
  const t = requireTask(app, id);
  if (!applyPersonEvent(app, id, { type: 'park' }, { reason: reason?.trim() || null }))
    throw new ActionError(`#${id} is ${app.getTask(id)?.status ?? t.status}; only a proposed task can be parked`, undefined, 'conflict');
}

export function liftTask(app: App, id: TaskId): void {
  const t = requireTask(app, id);
  if (!applyPersonEvent(app, id, { type: 'lift' }))
    throw new ActionError(`#${id} is ${app.getTask(id)?.status ?? t.status}, not parked`, undefined, 'conflict');
}

export interface RetryInput {
  note?: string;
  model?: string;
  max_turns?: number;
}

export function retryTask(app: App, id: TaskId, input: RetryInput = {}, onlyFrom?: TaskStatus[]): { model: string; escalated: boolean } {
  const t = requireTask(app, id);
  refuseWhileSyncing(app, id);
  const { note, model, max_turns } = input;
  const badTurns = max_turns === undefined ? null : maxTurnsError(max_turns);
  if (badTurns) throw new ActionError(badTurns);
  if (note !== undefined && typeof note !== 'string') throw new ActionError('note must be text');
  if (model !== undefined && typeof model !== 'string') throw new ActionError('model must be text');
  const badModel = model === '' ? 'model must not be empty' : modelError(model);
  if (badModel) throw new ActionError(badModel);
  const from = fromStatuses({ type: 'retry' }).filter((s) => !onlyFrom || onlyFrom.includes(s));
  if (!from.includes(t.status)) throw new ActionError(`#${id} is ${t.status}`, undefined, 'conflict');
  if (max_turns !== undefined && max_turns !== t.max_turns && !app.changeMaxTurns(id, max_turns, from))
    throw new ActionError(`#${id} changed meanwhile; try again`, undefined, 'conflict');
  const escalated = model === undefined ? escalateOnRetry(app, t) : null;
  if (model !== undefined && model !== t.model && !app.changeModel(id, { from: t.model, to: model }, { type: 'edit' }, from))
    throw new ActionError(`#${id} changed meanwhile; try again`, undefined, 'conflict');
  const retried = applyPersonEvent(app, id, { type: 'retry' }, { reason: note?.trim() || null, onlyFrom });
  if (!retried) throw new ActionError(`#${id} is ${app.getTask(id)?.status ?? t.status}`, undefined, 'conflict');
  return { model: retried.model, escalated: escalated !== null };
}

export function markDone(app: App, id: TaskId, note?: string): void {
  const t = requireTask(app, id);
  if (note !== undefined && typeof note !== 'string') throw new ActionError('note must be text');
  if (!applyPersonEvent(app, id, { type: 'mark_done' }, { reason: note?.trim() || null }))
    throw new ActionError(
      `#${id} is ${app.getTask(id)?.status ?? t.status}; only blocked or failed tasks can be marked done`,
      undefined,
      'conflict',
    );
}
