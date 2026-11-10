// What the daemon does after a task's status changes: one table, from each domain event to its follow-ups.
import type { TaskEventType } from './history.ts';
import { type DomainEvent, type DomainEventType, type TaskStatus, domainEventOfRow } from './lifecycle.ts';

/**
 * - `open_pr`: open the task's pull request (agents cannot push), if it is still done
 * - `warn_dependents`: tell a person, once, about the queued tasks that now cannot start because of it
 * - `notify`: tell a person the task is done, blocked or failed
 */
export type FollowUp = 'open_pr' | 'warn_dependents' | 'notify';

export const FOLLOW_UP_ORDER: FollowUp[] = ['open_pr', 'warn_dependents', 'notify'];

export const FOLLOW_UPS: Record<DomainEventType, FollowUp[]> = {
  TaskStarted: [],
  TaskQueued: [],
  TaskFinished: ['open_pr', 'warn_dependents', 'notify'],
  TaskPrMerged: ['notify'],
  TaskPrClosed: ['warn_dependents'],
  TaskMarkedDone: [],
  TaskBlocked: ['warn_dependents', 'notify'],
  TaskFailed: ['warn_dependents', 'notify'],
  TaskCancelRequested: [],
  TaskCancelled: ['warn_dependents'],
};

export function followUpsOf(event: Pick<DomainEvent, 'type'>): FollowUp[] {
  const wanted = new Set(FOLLOW_UPS[event.type]);
  return FOLLOW_UP_ORDER.filter((f) => wanted.has(f));
}

export function followUpsOfRow(row: { type: TaskEventType; to_status: TaskStatus | null }): FollowUp[] {
  const type = domainEventOfRow(row);
  return type ? followUpsOf({ type }) : [];
}
