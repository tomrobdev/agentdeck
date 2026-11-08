// A merge request: a person's Merge, which the daemon carries out once the PR is ready (docs/plans/merge-requests.html). Pure: no I/O.
import { isMergeabilityUnknown } from './conflict.ts';
import { type AutoMergeCheck, verdictOf } from './auto-merge.ts';
import { DEFAULT_MERGE_METHOD, type MergeMethod } from '../repos/index.ts';
import { type MergeFinding, type MergeInput, conflictNeedsPerson, mergeFindings } from './merge.ts';
import type { PullRequest } from './pr.ts';

/**
 * What each merge-dialog finding means to a merge request. A person asked, so the auto-merge rules (label, line limit,
 * skipped paths, a pause) don't apply. Like auto-merge, a draft or a branch behind the base is fine; a conflict waits for
 * the sync the refresh starts (or needs a person when the repo has auto_resolve off), and the PRs it lands after wait for those to merge.
 */
const REQUESTED: Record<MergeFinding['kind'], 'never' | 'wait' | null> = {
  not_open: 'never',
  lands_after: 'wait',
  conflict: 'wait',
  draft: null,
  behind: null,
  blocked: 'never',
  tests_failed: 'never',
  checks_failing: 'never',
  checks_pending: 'wait',
};

/** Whether a requested merge may go ahead now (`merge`), waits for something that can change on its own, or needs a person (`never`). */
export function mergeRequestCheck(input: MergeInput): AutoMergeCheck {
  const reasons = { never: [] as string[], wait: [] as string[] };
  const found = mergeFindings(input);
  for (const f of found) {
    // While required checks run GitHub says BLOCKED too; the pending checks are the wait.
    const how =
      f.kind === 'blocked' && input.pr.checks.pending
        ? null
        : f.kind === 'conflict' && conflictNeedsPerson(input)
          ? 'never'
          : REQUESTED[f.kind];
    if (how) reasons[how].push(f.text);
  }
  if (isMergeabilityUnknown(input.pr)) reasons.wait.push('GitHub is still working out whether it merges cleanly');
  return verdictOf(reasons, found);
}

/**
 * Whether the merge dialog merges now instead of asking for a merge request. Failing checks or failed tests stop a request
 * for good, so the person may wave them through, here and now; anything else goes through a request.
 */
export const mergesNow = (
  check: AutoMergeCheck,
  input: Pick<MergeInput, 'tests_passed'> & { pr: Pick<MergeInput['pr'], 'checks'> },
): boolean => check.verdict === 'never' && (input.pr.checks.failing > 0 || input.tests_passed === false);

/** Whether a waiting request is worth reading again soon: its checks are running, or GitHub is working out mergeability. */
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

/**
 * Whether this PR is open and conflicts with the base branch, as the last PR check found it: the merge request's check, else
 * auto-merge's. False with neither (auto-merge off and no merge request: nothing stores a check).
 */
export function conflictsWithBase(pr: PullRequest | null): boolean {
  if (pr?.state !== 'open') return false;
  const check = pr.merge_request?.check ?? pr.auto_merge_check;
  return check?.conflict === true;
}

/** This PR's merge request, or null when it has none. `merging`: a merge of this task is under way in this process. */
export function mergeRequestView(pr: PullRequest | null, merging: boolean): MergeRequestView | null {
  const request = pr?.merge_request;
  if (!request) return null;
  const reasons = merging ? [] : (request.check?.reasons ?? []);
  return {
    state: merging ? 'merging' : 'waiting',
    method: request.method ?? DEFAULT_MERGE_METHOD,
    reasons,
    since: request.requested_at,
  };
}
