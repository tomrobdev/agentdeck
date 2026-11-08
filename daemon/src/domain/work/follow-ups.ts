// What the daemon does after a task's status changes: one table, from each domain event to its follow-ups. Pure: no I/O.
// application/landing/settle.ts runs it, for the daemon's events and for a person's.
import type { DomainEvent, DomainEventType } from './lifecycle.ts';

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
 * Crash recovery follows up only the tasks it failed (`settleRecovered`).
 */
export const FOLLOW_UPS: Record<DomainEventType, FollowUp[]> = {
  TaskStarted: [],
  TaskQueued: [],
  TaskFinished: ['open_pr', 'warn_dependents', 'notify'],
  TaskPrMerged: ['warn_dependents', 'notify'], // it has a PR: that is how it got here
  TaskMarkedDone: [],
  TaskBlocked: ['warn_dependents', 'notify'],
  TaskFailed: ['warn_dependents', 'notify'],
  TaskCancelRequested: [],
  TaskCancelled: ['warn_dependents'],
};

/** What follows `events`, each follow-up once, in `FOLLOW_UP_ORDER`. */
export function followUpsOf(events: Pick<DomainEvent, 'type'>[]): FollowUp[] {
  const wanted = new Set(events.flatMap((e) => FOLLOW_UPS[e.type]));
  return FOLLOW_UP_ORDER.filter((f) => wanted.has(f));
}
