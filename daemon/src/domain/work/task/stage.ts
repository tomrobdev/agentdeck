// Where a task stands, derived from its status, its pull request and what it waits for.
import { type PrRetry, type PrState, prNeedsPerson } from '../../landing/index.ts';
import type { TaskStatus } from '../lifecycle/lifecycle.ts';
import type { Waiting } from './start.ts';

type Stage = {
  status: TaskStatus;
  pr_state: PrState | null;
  /** What a queued task waits for on its builds-on links, as `waitingFor` (start.ts) reports it. */
  waiting?: Waiting | null;
  /** For a done task whose PR failed to open: whether the PR refresh opens it again, or a person must. */
  pr_retry?: Pick<PrRetry, 'state'> | null;
};

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

export const hasOpenPr = (t: Pick<Stage, 'pr_state'>) => t.pr_state === 'open';
export const isReview = (t: Pick<Stage, 'status' | 'pr_state'>) => t.status === 'done' && hasOpenPr(t);
export const canStartMerge = (t: Pick<Stage, 'status' | 'pr_state'> & { sync?: unknown; merge_request?: unknown }) =>
  isReview(t) && !t.sync && !t.merge_request;
export const canOpenPr = (t: Pick<Stage, 'status' | 'pr_state' | 'pr_retry'>) =>
  t.status === 'done' && (!!t.pr_retry || t.pr_state === 'closed');
export const isMerged = (t: Pick<Stage, 'status' | 'pr_state'>) => t.status === 'done' && t.pr_state === 'merged';
export const isWaiting = (t: Pick<Stage, 'status' | 'waiting'>) => t.status === 'queued' && !!t.waiting && !t.waiting.stuck;
export const isStuck = (t: Pick<Stage, 'status' | 'waiting'>) => t.status === 'queued' && !!t.waiting?.stuck;

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
