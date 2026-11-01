// Whether a PR can be merged, and how. Pure: no I/O.
import { isConflicting } from './conflict.ts';
import type { PrState } from './pr.ts';
import { plural } from '../text.ts';

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
  /** The changed files' paths, and the labels; empty unless asked for (`prDetails`'s `withFiles`). */
  paths: string[];
  labels: string[];
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

/** Read `gh pr view --json isDraft,mergeable,mergeStateStatus,commits,additions,deletions,changedFiles,statusCheckRollup,files,labels`. */
export function parsePrDetails(json: string): PrDetails {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  const names = (v: unknown, key: string) =>
    Array.isArray(v) ? v.map((item) => (item as Record<string, unknown>)?.[key]).filter((n): n is string => typeof n === 'string') : [];
  return {
    draft: raw.isDraft === true,
    mergeable: String(raw.mergeable ?? 'UNKNOWN'),
    merge_state: String(raw.mergeStateStatus ?? 'UNKNOWN'),
    commits: Array.isArray(raw.commits) ? raw.commits.length : num(raw.commits),
    files: num(raw.changedFiles),
    additions: num(raw.additions),
    deletions: num(raw.deletions),
    checks: countChecks(raw.statusCheckRollup),
    paths: names(raw.files, 'path'),
    labels: names(raw.labels, 'name'),
  };
}

/** One fact about a PR that bears on merging it. A problem stops any merge; anything else is a warning a person may wave through. */
export interface MergeFinding {
  kind: 'not_open' | 'conflict' | 'draft' | 'behind' | 'blocked' | 'tests_failed' | 'checks_failing' | 'checks_pending';
  problem: boolean;
  text: string;
}

export interface MergeCheck {
  /** Reasons the merge can't go ahead. */
  problems: string[];
  /** Things worth a second look, shown above the confirm button. */
  warnings: string[];
}

export interface MergeInput {
  pr_state: PrState | null;
  pr: PrDetails;
  /** The last run that ran the tests: 1 passed, 0 failed, null none did. */
  tests_passed: number | null;
}

/** What about a PR's state bears on merging it, in the order the merge dialog shows it. */
export function mergeFindings({ pr_state, pr, tests_passed }: MergeInput): MergeFinding[] {
  const found: MergeFinding[] = [];
  const add = (kind: MergeFinding['kind'], text: string, problem = false) => found.push({ kind, problem, text });
  if (pr_state !== 'open') add('not_open', `the PR is ${pr_state ?? 'not open'}`, true);
  if (isConflicting(pr)) add('conflict', 'the branch has conflicts with the base branch', true);
  if (pr.draft) add('draft', 'the PR is a draft; it will be marked ready for review first');
  if (pr.merge_state === 'BEHIND') add('behind', 'the base branch has moved on since the branch was cut');
  if (pr.merge_state === 'BLOCKED' && !pr.draft)
    add('blocked', 'GitHub says branch protection may block this merge (required reviews or checks)');
  if (tests_passed === 0) add('tests_failed', 'tests failed on the last run');
  if (pr.checks.failing) add('checks_failing', `${plural(pr.checks.failing, 'check')} failing on GitHub`);
  if (pr.checks.pending) add('checks_pending', `${plural(pr.checks.pending, 'check')} still running on GitHub`);
  return found;
}

/** Turn a PR's state into blocking problems and warnings. */
export function mergeCheck(input: MergeInput): MergeCheck {
  const found = mergeFindings(input);
  return { problems: found.filter((f) => f.problem).map((f) => f.text), warnings: found.filter((f) => !f.problem).map((f) => f.text) };
}
