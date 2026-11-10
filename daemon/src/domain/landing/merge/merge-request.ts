// A merge request: a person's Merge, which the daemon carries out once the PR is ready (docs/plans/merge-requests.html).
import { isMergeabilityUnknown } from './conflict.ts';
import { DEFAULT_MERGE_METHOD, type MergeMethod } from '../../repos/index.ts';
import { type AutoMergeCheck, type MergeInput, reasonTexts, unattendedVerdict } from './merge.ts';
import type { PullRequest } from '../pull-request/pr.ts';

export const mergeRequestCheck = (input: MergeInput): AutoMergeCheck => unattendedVerdict(input);

export const mergesNow = (
  check: AutoMergeCheck,
  input: Pick<MergeInput, 'tests_passed'> & { pr: Pick<MergeInput['pr'], 'checks'> },
): boolean => check.verdict === 'never' && (input.pr.checks.failing > 0 || input.tests_passed === false);

export const mergeRequestPolls = (check: AutoMergeCheck, pr: Pick<MergeInput['pr'], 'checks' | 'mergeable' | 'merge_state'>): boolean =>
  check.verdict === 'wait' && (pr.checks.pending > 0 || isMergeabilityUnknown(pr));

/** What a view says about a task's merge request: waiting for the PR to be ready, or merging it now. */
export interface MergeRequestView {
  state: 'waiting' | 'merging';
  method: MergeMethod;
  /** Why it waits, from the last check; empty before the first check and while merging. */
  reasons: string[];
  /** When the person asked (UTC, `YYYY-MM-DD HH:MM:SS`). */
  since: string;
}

export function conflictsWithBase(pr: PullRequest | null): boolean {
  if (pr?.state !== 'open') return false;
  const check = pr.merge_request?.check ?? pr.auto_merge_check;
  return check?.conflict === true;
}

export function mergeRequestView(pr: PullRequest | null, merging: boolean): MergeRequestView | null {
  const request = pr?.merge_request;
  if (!request) return null;
  const reasons = merging ? [] : reasonTexts(request.check?.reasons ?? []);
  return {
    state: merging ? 'merging' : 'waiting',
    method: request.method ?? DEFAULT_MERGE_METHOD,
    reasons,
    since: request.requested_at,
  };
}
