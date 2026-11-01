// A merge request: a person's Merge, which the daemon carries out once the PR is ready (docs/plans/merge-requests.html). Pure: no I/O.
import type { Task } from '../task/task.ts';
import { isMergeabilityUnknown } from './conflict.ts';
import { type AutoMergeCheck, readAutoMergeCheck } from './auto-merge.ts';
import { DEFAULT_MERGE_METHOD, type MergeFinding, type MergeInput, type MergeMethod, mergeFindings } from './merge.ts';

/**
 * What each merge-dialog finding means to a merge request. A person asked, so the auto-merge rules (label, line limit,
 * skipped paths, a pause) don't apply. Like auto-merge, a draft or a branch behind the base is fine; a conflict waits for
 * the sync the refresh starts, and the PRs it lands after wait for those to merge.
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
  for (const f of mergeFindings(input)) {
    // While required checks run GitHub says BLOCKED too; the pending checks are the wait.
    const how = f.kind === 'blocked' && input.pr.checks.pending ? null : REQUESTED[f.kind];
    if (how) reasons[how].push(f.text);
  }
  if (isMergeabilityUnknown(input.pr)) reasons.wait.push('GitHub is still working out whether it merges cleanly');
  if (reasons.never.length) return { verdict: 'never', reasons: reasons.never };
  if (reasons.wait.length) return { verdict: 'wait', reasons: reasons.wait };
  return { verdict: 'merge', reasons: [] };
}

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

/** The task's merge request, or null when it has none. `merging`: a merge of this task is under way in this process. */
export function mergeRequestView(
  task: Pick<Task, 'merge_requested_at' | 'merge_request_method' | 'merge_request_check'>,
  merging: boolean,
): MergeRequestView | null {
  if (!task.merge_requested_at) return null;
  const reasons = merging ? [] : (readAutoMergeCheck(task.merge_request_check)?.reasons ?? []);
  return {
    state: merging ? 'merging' : 'waiting',
    method: task.merge_request_method ?? DEFAULT_MERGE_METHOD,
    reasons,
    since: task.merge_requested_at,
  };
}
