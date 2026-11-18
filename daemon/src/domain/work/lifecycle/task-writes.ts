// The changes a task's non-status writes make, where a rule decides them (rule:task-writes).
import type { AutoMergeCheck, CheckCounts, PrState, PullRequest, StoredChecks } from '#domain/landing/index.ts';
import type { MergeMethod } from '#domain/repos/index.ts';
import type { PrEvent } from '#domain/work/lifecycle/history.ts';
import type { TaskStatus } from '#domain/work/lifecycle/lifecycle.ts';
import type { UnblockQuestion } from '#domain/work/task/needs.ts';

/** The fields of a task a write sets, named as its columns are; the store stores the documents as JSON. `'now'` is a timestamp it fills in. */
export interface TaskChanges {
  model?: string;
  max_turns?: number;
  question?: UnblockQuestion | null;
  auto_merge?: boolean | null;
  auto_merge_check?: AutoMergeCheck | null;
  auto_merge_checked_at?: 'now' | null;
  merge_requested_at?: 'now' | null;
  merge_request_method?: MergeMethod | null;
  merge_request_check?: AutoMergeCheck | null;
  pr_url?: string;
  pr_state?: PrState | null;
  pr_checks?: StoredChecks | null;
  pr_checks_opened?: CheckCounts | null;
  pr_checks_merged?: CheckCounts | null;
  merge_method?: MergeMethod;
}

const NO_MERGE_REQUEST = { merge_requested_at: null, merge_request_method: null, merge_request_check: null } as const;
const NO_AUTO_MERGE_CHECK = { auto_merge_check: null, auto_merge_checked_at: null } as const;

export const modelChanges = (to: string): TaskChanges => ({ model: to });

export const maxTurnsChanges = (to: number): TaskChanges => ({ max_turns: to });

export const questionChanges = (question: UnblockQuestion): TaskChanges => ({ question });

export const autoMergeSettingChanges = (value: boolean | null): TaskChanges => ({ auto_merge: value, ...NO_AUTO_MERGE_CHECK });

export const autoMergeCheckChanges = (check: AutoMergeCheck | null): TaskChanges => ({
  auto_merge_check: check,
  auto_merge_checked_at: check === null ? null : 'now',
});

export const mergeRequestChanges = (method: MergeMethod): TaskChanges => ({
  merge_requested_at: 'now',
  merge_request_method: method,
  merge_request_check: null,
});

export const noMergeRequestChanges = (): TaskChanges => ({ ...NO_MERGE_REQUEST });

const PR_SET_ASIDE = { pr_state: null, ...NO_AUTO_MERGE_CHECK, ...NO_MERGE_REQUEST } as const;

export function statusChangePrChanges(
  from: TaskStatus,
  to: TaskStatus,
  retried: boolean,
  pr: Pick<PullRequest, 'state'> | null,
): TaskChanges {
  if (retried && pr !== null && pr.state !== 'open') return { ...PR_SET_ASIDE };
  if (from === 'done' && to !== 'done') return noMergeRequestChanges();
  return {};
}

export const mergeRequestCheckChanges = (check: AutoMergeCheck): TaskChanges => ({ merge_request_check: check });

export const prChecksOpenedChanges = (checks: CheckCounts): TaskChanges => ({ pr_checks_opened: checks });

export const prChecksChanges = (checks: StoredChecks): TaskChanges => ({ pr_checks: checks });

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

export const mergedPrChanges = (method: MergeMethod, checks?: CheckCounts): TaskChanges => ({
  pr_state: 'merged',
  merge_method: method,
  ...(checks ? { pr_checks_merged: checks } : {}),
  ...NO_AUTO_MERGE_CHECK,
  ...NO_MERGE_REQUEST,
});
