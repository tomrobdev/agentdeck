// A merge request: a person's Merge, which the daemon carries out once the PR is ready.
import { isMergeabilityUnknown } from '#domain/landing/merge/conflict.ts';
import { DEFAULT_MERGE_METHOD, type MergeMethod } from '#domain/repos/index.ts';
import { type AutoMergeCheck, type MergeInput, reasonTexts, unattendedVerdict } from '#domain/landing/merge/merge.ts';
import type { PullRequest } from '#domain/landing/pull-request/pr.ts';

export const MERGE_REQUEST_STATES = ['none', 'requested'] as const;
/** Whether a task has a person's merge request on its PR. */
export type MergeRequestState = (typeof MERGE_REQUEST_STATES)[number];

/** What happens to a merge request: a person asks (again, with a new method), the daemon merges the PR, a person or the PR's end drops it, or its check or the merge says it needs a person. */
export type MergeRequestMove = 'asked' | 'carried_out' | 'dropped' | 'refused';

export const MERGE_REQUEST_MOVES: Record<MergeRequestMove, Partial<Record<MergeRequestState, MergeRequestState>>> = {
  asked: { none: 'requested', requested: 'requested' },
  carried_out: { requested: 'none' },
  dropped: { requested: 'none' },
  refused: { requested: 'none' },
};

export const mergeRequestStateOf = (pr: Pick<PullRequest, 'merge_request'> | null): MergeRequestState =>
  pr?.merge_request ? 'requested' : 'none';

export function nextMergeRequestState(from: MergeRequestState, move: MergeRequestMove): MergeRequestState | null {
  return MERGE_REQUEST_MOVES[move][from] ?? null;
}

export function mergeRequestStatesFor(move: MergeRequestMove): MergeRequestState[] {
  return MERGE_REQUEST_STATES.filter((s) => MERGE_REQUEST_MOVES[move][s] !== undefined);
}

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
