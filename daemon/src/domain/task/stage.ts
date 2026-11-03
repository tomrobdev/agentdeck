// Where a task stands, derived from its status, its pull request and what it waits for. Pure: types only.
// The one definition: the CLI's listing and the dashboard (which imports this file) both use it.
import type { PrState } from '../pull-request/pr.ts';
import type { TaskStatus } from './lifecycle.ts';
import type { Waiting } from './start.ts';

type Stage = {
  status: TaskStatus;
  pr_state: PrState | null;
  /** What a queued task waits for on its builds-on links, as application/task/dependencies.ts waitingFor reports it. */
  waiting?: Waiting | null;
};

/** Whether a task's pull request is open. The only place that spells out what open means. */
export const hasOpenPr = (t: Pick<Stage, 'pr_state'>) => t.pr_state === 'open';
/** A done task whose pull request waits on you. */
export const isReview = (t: Pick<Stage, 'status' | 'pr_state'>) => t.status === 'done' && hasOpenPr(t);
/** A done task whose pull request is merged: finished history. */
export const isMerged = (t: Pick<Stage, 'status' | 'pr_state'>) => t.status === 'done' && t.pr_state === 'merged';
/** A queued task whose dependency is on its way. */
export const isWaiting = (t: Pick<Stage, 'status' | 'waiting'>) => t.status === 'queued' && !!t.waiting && !t.waiting.stuck;
/** A queued task whose dependency won't get there on its own: a person has to act. */
export const isStuck = (t: Pick<Stage, 'status' | 'waiting'>) => t.status === 'queued' && !!t.waiting?.stuck;

/**
 * Status groups, in attention order. Every task is in exactly one; a stuck task needs you, so it isn't queued. Done holds every
 * finished task whose PR doesn't wait on you: merged, closed, or none. The PR chip tells them apart.
 */
export const STATUS_GROUPS = [
  { key: 'needs-you', label: 'Needs you' },
  { key: 'review', label: 'Review' },
  { key: 'proposed', label: 'Proposed' },
  { key: 'running', label: 'Running' },
  { key: 'queued', label: 'Queued' },
  { key: 'done', label: 'Done' },
  { key: 'cancelled', label: 'Cancelled' },
] as const;
export type StatusGroup = (typeof STATUS_GROUPS)[number]['key'];

export function statusGroup(t: Stage): StatusGroup {
  switch (t.status) {
    case 'blocked':
    case 'failed':
      return 'needs-you';
    case 'queued':
      return isStuck(t) ? 'needs-you' : 'queued';
    case 'cancel_requested':
      return 'running';
    case 'done':
      return isReview(t) ? 'review' : 'done';
    default:
      return t.status;
  }
}
