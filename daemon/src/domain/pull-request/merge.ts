// Whether a PR can be merged, and how. Pure: no I/O.
import { isConflicting } from './conflict.ts';
import type { PrState } from './pr.ts';

/** How GitHub folds the PR into the base branch. Squash is the default: one task, one commit. */
export type MergeMethod = 'squash' | 'merge' | 'rebase';
export const MERGE_METHODS: MergeMethod[] = ['squash', 'merge', 'rebase'];
export const DEFAULT_MERGE_METHOD: MergeMethod = 'squash';

export const isMergeMethod = (value: unknown): value is MergeMethod => MERGE_METHODS.includes(value as MergeMethod);

/** What GitHub reports about a PR's checks. */
export interface CheckCounts {
  total: number;
  failing: number;
  pending: number;
}

/** What `gh pr view` says about a PR that decides whether and how it merges. */
export interface PrDetails {
  draft: boolean;
  /** GitHub's `mergeable`: MERGEABLE, CONFLICTING or UNKNOWN. */
  mergeable: string;
  /** GitHub's `mergeStateStatus`: CLEAN, BEHIND, DIRTY, BLOCKED, UNSTABLE, DRAFT, … */
  merge_state: string;
  commits: number;
  files: number;
  additions: number;
  deletions: number;
  checks: CheckCounts;
}

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED']);
const PENDING = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED']);

/** Count `statusCheckRollup` entries: check runs have `status` and `conclusion`, commit statuses have `state`. */
export function countChecks(rollup: unknown): CheckCounts {
  const items = Array.isArray(rollup) ? (rollup as Record<string, unknown>[]) : [];
  const counts: CheckCounts = { total: items.length, failing: 0, pending: 0 };
  for (const item of items) {
    const verdict = String(item.conclusion || item.state || item.status || '').toUpperCase();
    if (FAILED.has(verdict)) counts.failing++;
    else if (PENDING.has(verdict)) counts.pending++;
  }
  return counts;
}

/** Read `gh pr view --json isDraft,mergeable,mergeStateStatus,commits,additions,deletions,changedFiles,statusCheckRollup`. */
export function parsePrDetails(json: string): PrDetails {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  return {
    draft: raw.isDraft === true,
    mergeable: String(raw.mergeable ?? 'UNKNOWN'),
    merge_state: String(raw.mergeStateStatus ?? 'UNKNOWN'),
    commits: Array.isArray(raw.commits) ? raw.commits.length : num(raw.commits),
    files: num(raw.changedFiles),
    additions: num(raw.additions),
    deletions: num(raw.deletions),
    checks: countChecks(raw.statusCheckRollup),
  };
}

export interface MergeCheck {
  /** Reasons the merge can't go ahead. */
  problems: string[];
  /** Things worth a second look, shown above the confirm button. */
  warnings: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Turn a PR's state into blocking problems and warnings. `testsPassed` is the task's last run. */
export function mergeCheck(input: { pr_state: PrState | null; pr: PrDetails; tests_passed: number | null }): MergeCheck {
  const { pr_state, pr, tests_passed } = input;
  const problems: string[] = [];
  const warnings: string[] = [];
  if (pr_state !== 'open') problems.push(`the PR is ${pr_state ?? 'not open'}`);
  if (isConflicting(pr)) problems.push('the branch has conflicts with the base branch');
  if (pr.draft) warnings.push('the PR is a draft; it will be marked ready for review first');
  if (pr.merge_state === 'BEHIND') warnings.push('the base branch has moved on since the branch was cut');
  if (pr.merge_state === 'BLOCKED' && !pr.draft)
    warnings.push('GitHub says branch protection may block this merge (required reviews or checks)');
  if (tests_passed === 0) warnings.push('tests failed on the last run');
  if (pr.checks.failing) warnings.push(`${plural(pr.checks.failing, 'check')} failing on GitHub`);
  if (pr.checks.pending) warnings.push(`${plural(pr.checks.pending, 'check')} still running on GitHub`);
  return { problems, warnings };
}
