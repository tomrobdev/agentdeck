// The changes a task's non-status writes make, where a rule decides them (rule:task-writes). Pure: each function returns the fields to
// store, and the store in db/ only persists them under its guard. A timestamp the store sets is `'now'`.
import type { AutoMergeCheck, CheckCounts, PrState, StoredChecks } from '../landing/index.ts';
import type { MergeMethod } from '../repos/index.ts';
import type { PrEvent } from './history.ts';
import type { UnblockQuestion } from './needs.ts';

/** The fields of a task a write sets, named as its columns are; the store stores the documents as JSON. `'now'` is a timestamp it fills in. */
export interface TaskChanges {
  question?: UnblockQuestion | null;
  auto_merge?: boolean | null;
  auto_merge_check?: AutoMergeCheck | null;
  auto_merge_checked_at?: 'now' | null;
  merge_requested_at?: 'now' | null;
  merge_request_method?: MergeMethod | null;
  merge_request_check?: AutoMergeCheck | null;
  pr_url?: string;
  pr_state?: PrState;
  pr_checks?: StoredChecks | null;
  pr_checks_opened?: CheckCounts | null;
  pr_checks_merged?: CheckCounts | null;
  merge_method?: MergeMethod;
}

/** A task with no merge request. */
const NO_MERGE_REQUEST = { merge_requested_at: null, merge_request_method: null, merge_request_check: null } as const;
/** A task with no auto-merge check: one is made for a setting and a PR state, so it goes when either changes. */
const NO_AUTO_MERGE_CHECK = { auto_merge_check: null, auto_merge_checked_at: null } as const;

/** What an unblock run's question changes: the question stays on the blocked task. */
export const questionChanges = (question: UnblockQuestion): TaskChanges => ({ question });

/** A task's own auto-merge setting (true, false, or null for the repo's): the stored check was made for the old one, so it goes. */
export const autoMergeSettingChanges = (value: boolean | null): TaskChanges => ({ auto_merge: value, ...NO_AUTO_MERGE_CHECK });

/** The PR refresh's latest auto-merge check, or none (null): it is stamped when there is one. */
export const autoMergeCheckChanges = (check: AutoMergeCheck | null): TaskChanges => ({
  auto_merge_check: check,
  auto_merge_checked_at: check === null ? null : 'now',
});

/** A person's request to merge once the PR is ready. A new request starts without a check. */
export const mergeRequestChanges = (method: MergeMethod): TaskChanges => ({
  merge_requested_at: 'now',
  merge_request_method: method,
  merge_request_check: null,
});

/** A dropped merge request. */
export const noMergeRequestChanges = (): TaskChanges => ({ ...NO_MERGE_REQUEST });

/** The PR refresh's latest check of a merge request. */
export const mergeRequestCheckChanges = (check: AutoMergeCheck): TaskChanges => ({ merge_request_check: check });

/** The checks a PR had when they first settled. */
export const prChecksOpenedChanges = (checks: CheckCounts): TaskChanges => ({ pr_checks_opened: checks });

/** The PR refresh's latest checks. */
export const prChecksChanges = (checks: StoredChecks): TaskChanges => ({ pr_checks: checks });

/**
 * What a change to a task's PR sets. A PR that is no longer open has no auto-merge check or merge request, and a newly opened PR
 * starts with none of the checks of an earlier one.
 */
export function prChanges(e: PrEvent): TaskChanges {
  const state: TaskChanges =
    e.type === 'opened'
      ? { pr_url: e.url, pr_state: 'open', pr_checks_opened: null, pr_checks_merged: null, pr_checks: null }
      : e.type === 'failed'
        ? { pr_state: 'failed' }
        : e.type === 'closed'
          ? { pr_state: 'closed' }
          : { pr_state: e.state };
  return { ...state, ...NO_AUTO_MERGE_CHECK, ...NO_MERGE_REQUEST };
}

/** What a merged PR sets: its state, the method, the checks it merged on, and no check or request. */
export const mergedPrChanges = (method: MergeMethod, checks?: CheckCounts): TaskChanges => ({
  pr_state: 'merged',
  merge_method: method,
  ...(checks ? { pr_checks_merged: checks } : {}),
  ...NO_AUTO_MERGE_CHECK,
  ...NO_MERGE_REQUEST,
});
