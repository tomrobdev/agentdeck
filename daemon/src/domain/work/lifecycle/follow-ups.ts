// What the daemon does after a task's status changes: one table, from each domain event to its follow-ups. Pure: no I/O.
// application/landing/settle.ts runs it, for the daemon's events and for a person's. A status change whose event has
// follow-ups writes its task_events row pending (the outbox), and the row is marked once they ran, so a crash between
// the two loses nothing: the daemon's tick runs what is pending.
import type { TaskEventType } from './history.ts';
import { type DomainEvent, type DomainEventType, type TaskStatus, domainEventOfRow } from './lifecycle.ts';

/**
 * - `open_pr`: open the task's pull request (agents cannot push), if it is still done
 * - `warn_dependents`: tell a person, once, about the queued tasks that now cannot start because of it
 * - `notify`: tell a person the task is done, blocked or failed
 */
export type FollowUp = 'open_pr' | 'warn_dependents' | 'notify';

/** The order follow-ups run in: the PR first, since whether it opened decides if dependents are stuck, and goes in the notification. */
export const FOLLOW_UP_ORDER: FollowUp[] = ['open_pr', 'warn_dependents', 'notify'];

/**
 * domain event → its follow-ups. Only the daemon's events notify: a person knows what they just did. A task that is queued,
 * running or asked to stop strands no one, so those warn no one; nor does a task a person marked done, which counts as met.
 * Crash recovery's events are followed up like any other: a task it failed warns and notifies, one it cancelled warns.
 */
export const FOLLOW_UPS: Record<DomainEventType, FollowUp[]> = {
  TaskStarted: [],
  TaskQueued: [],
  TaskFinished: ['open_pr', 'warn_dependents', 'notify'],
  TaskPrMerged: ['notify'], // a task with a merged PR is met, so it strands no one
  TaskPrClosed: ['warn_dependents'], // a closed PR is never merged: the tasks that build on it are stuck until it is retried
  TaskMarkedDone: [],
  TaskBlocked: ['warn_dependents', 'notify'],
  TaskFailed: ['warn_dependents', 'notify'],
  TaskCancelRequested: [],
  TaskCancelled: ['warn_dependents'],
};

/** What follows `event`, in `FOLLOW_UP_ORDER`. */
export function followUpsOf(event: Pick<DomainEvent, 'type'>): FollowUp[] {
  const wanted = new Set(FOLLOW_UPS[event.type]);
  return FOLLOW_UP_ORDER.filter((f) => wanted.has(f));
}

/**
 * What follows the status change a task_events row records (`domainEventOfRow`), for a row the outbox kept: its follow-ups
 * were still to run when the daemon stopped, or the CLI wrote it. Empty for a row that changed no status.
 */
export function followUpsOfRow(row: { type: TaskEventType; to_status: TaskStatus | null }): FollowUp[] {
  const type = domainEventOfRow(row);
  return type ? followUpsOf({ type }) : [];
}
