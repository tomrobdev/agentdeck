// Where a task stands, derived from its status, its pull request and what it waits for. Pure: types only.
// The one definition: the CLI's listing and the dashboard (which imports this file) both use it.
import { type PrRetry, type PrState, prNeedsPerson } from '../landing/index.ts';
import type { TaskStatus } from './lifecycle.ts';
import type { Waiting } from './start.ts';

type Stage = {
  status: TaskStatus;
  pr_state: PrState | null;
  /** What a queued task waits for on its builds-on links, as `waitingFor` (start.ts) reports it. */
  waiting?: Waiting | null;
  /** For a done task whose PR failed to open: whether the PR refresh opens it again, or a person must. */
  pr_retry?: Pick<PrRetry, 'state'> | null;
};

/** A task's stage fields from its pull request value: the predicates below read the flat `pr_state` the dashboard receives. */
export const stageOf = (t: {
  status: TaskStatus;
  pr: { state: PrState } | null;
  waiting?: Waiting | null;
  pr_retry?: Pick<PrRetry, 'state'> | null;
}) => ({
  status: t.status,
  pr_state: t.pr?.state ?? null,
  waiting: t.waiting,
  pr_retry: t.pr_retry,
});

/** Whether a task's pull request is open. The only place that spells out what open means. */
export const hasOpenPr = (t: Pick<Stage, 'pr_state'>) => t.pr_state === 'open';
/** A done task whose pull request waits on you. */
export const isReview = (t: Pick<Stage, 'status' | 'pr_state'>) => t.status === 'done' && hasOpenPr(t);
/**
 * A task in review a person may start a merge of now: not while it syncs (the daemon refuses that merge) nor while a merge
 * request already waits. The one rule every Merge button, key and menu uses.
 */
export const canStartMerge = (t: Pick<Stage, 'status' | 'pr_state'> & { sync?: unknown; merge_request?: unknown }) =>
  isReview(t) && !t.sync && !t.merge_request;
/**
 * A done task whose PR a person may open (`agentdeck open-pr`, the Open PR button): it failed to open in a repo with a PR mode
 * (`pr_retry` says so, whether the PR refresh still retries it or stopped), or it was closed.
 */
export const canOpenPr = (t: Pick<Stage, 'status' | 'pr_state' | 'pr_retry'>) =>
  t.status === 'done' && (!!t.pr_retry || t.pr_state === 'closed');
/** A done task whose pull request is merged: finished history. */
export const isMerged = (t: Pick<Stage, 'status' | 'pr_state'>) => t.status === 'done' && t.pr_state === 'merged';
/** A queued task whose dependency is on its way. */
export const isWaiting = (t: Pick<Stage, 'status' | 'waiting'>) => t.status === 'queued' && !!t.waiting && !t.waiting.stuck;
/** A queued task whose dependency won't get there on its own: a person has to act. */
export const isStuck = (t: Pick<Stage, 'status' | 'waiting'>) => t.status === 'queued' && !!t.waiting?.stuck;

/**
 * Status groups, in attention order. Every task is in exactly one; a stuck task needs you, so it isn't queued, and so does a
 * done task whose PR the daemon gave up opening. Done holds every finished task whose PR doesn't wait on you: merged, closed,
 * or none. The PR chip tells them apart.
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
      return isReview(t) ? 'review' : prNeedsPerson(t) ? 'needs-you' : 'done';
    default:
      return t.status;
  }
}
