// Whether the daemon may merge a done task's PR without a person (docs/plans/auto-merge.html). Pure: no I/O.
import type { Repo } from '../repos/index.ts';
import { PROTECTED_PREFIXES, isProtectedPath } from '../repos/index.ts';
import { wholeNumberError } from '../shared/index.ts';
import { checksRan } from './checks.ts';
import { type AutoMergeCheck, type MergeInput, type MergeReason, type MergeReasonKind, reasonTexts, unattendedVerdict } from './merge.ts';
import type { PullRequest } from './pr.ts';
import { type ReviewFacts, reviewGate } from './review-gate.ts';

/** The label a PR carries while the daemon may merge it. Removing it on GitHub opts that PR out. */
export const AUTO_MERGE_LABEL = {
  name: 'agentdeck:auto-merge',
  description: 'AgentDeck merges this PR once its checks pass',
  color: '0e8a16',
};
export const DEFAULT_AUTO_MERGE_MAX_LINES = 400;
export const DEFAULT_AUTO_MERGE_SKIP = ['.github/'];

/** What a task says about its own auto-merge: its setting (null follows the repo) and who made it. */
export interface AutoMergeSetting {
  auto_merge: boolean | null;
  source: string;
}

/**
 * Whether auto-merge is on for a task: its own setting, else its repo's. A planner proposal only takes the repo's
 * setting when a person approved it (the repo has auto_approve off), so no work reaches the base unseen.
 */
export function autoMergeOn(task: AutoMergeSetting, repo: Pick<Repo, 'auto_merge' | 'auto_approve'>): boolean {
  if (task.auto_merge !== null) return task.auto_merge;
  return repo.auto_merge && (task.source !== 'planner' || !repo.auto_approve);
}

const someOf = (paths: string[]) => `${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` and ${paths.length - 3} more` : ''}`;

/**
 * Why changed `paths` keep a PR from auto-merging: protected files (under .claude/, whatever the repo's skip list says),
 * which instruct every later agent, and the repo's `auto_merge_skip` prefixes. Empty when none are touched.
 */
export function pathReasons(paths: string[], skip: string[]): MergeReason[] {
  const protectedPaths = paths.filter(isProtectedPath);
  const skipped = paths.filter((path) => !isProtectedPath(path) && skip.some((prefix) => path.startsWith(prefix)));
  const reasons: MergeReason[] = [];
  if (protectedPaths.length)
    reasons.push({
      kind: 'protected_paths',
      text: `changes ${someOf(protectedPaths)}: files under ${PROTECTED_PREFIXES.join(', ')} steer every later agent`,
    });
  if (skipped.length) reasons.push({ kind: 'skipped_paths', text: `touches ${someOf(skipped)}` });
  return reasons;
}

export const autoMergeMaxLinesError = (value: unknown): string | null => wholeNumberError('auto_merge_max_lines', value, 1, 100_000);

/** What only auto-merge's check reads, beside the merge input: the repo's limits, a pause, and the branch as measured. */
export interface AutoMergeFacts {
  repo: Pick<Repo, 'test_cmd' | 'auto_merge_max_lines' | 'auto_merge_skip'>;
  /** Why the daemon or the repo is paused; null when neither is. */
  paused: string | null;
  /** The branch measured locally (`git diff --numstat` against the base); null or missing when it couldn't be. */
  measured?: AutoMergeMeasured | null;
  /**
   * What the review gate reads (`reviewGate`), in a repo with auto_review on; null or missing when it is off. Only
   * auto-merge waits on review runs: a person's merge and a merge request do not.
   */
  review?: ReviewFacts | null;
}

/**
 * Whether the daemon may merge this PR now, for a task with auto-merge on: the merge dialog's findings as a merge request
 * reads them (`unattendedVerdict`), plus what only auto-merge asks, in the order below. Something must have tested it: the last tested run passed, or the repo has no test command and
 * a CI check ran on the PR (passed or failed; skipped and neutral ones tested nothing). It must carry the label, stay
 * under the repo's limits, and nothing may be paused. The size is `measured` from git when the branch could be measured
 * at the PR's head; otherwise it is GitHub's, whose file list stops at 100, so a longer one needs a person.
 */
export function autoMergeCheck(input: MergeInput & AutoMergeFacts): AutoMergeCheck {
  const { repo, pr, tests_passed, measured } = input;
  const never: MergeReason[] = [];
  const add = (kind: MergeReasonKind, text: string) => never.push({ kind, text });
  if (!pr.labels.includes(AUTO_MERGE_LABEL.name)) add('no_label', `the PR has no ${AUTO_MERGE_LABEL.name} label`);
  if (repo.test_cmd && tests_passed === null) add('tests_not_run', 'the tests have not run');
  // A check that ran counts, not one skipped or neutral; one still running is the wait its finding says.
  if (!repo.test_cmd && tests_passed === null && !checksRan(pr) && !pr.checks.pending)
    add('untested', 'nothing tested it: the repo has no test command and no check ran on the PR');
  const lines = measured ? measured.lines : pr.additions + pr.deletions;
  const paths = measured ? measured.paths : pr.paths;
  if (lines > repo.auto_merge_max_lines) add('too_many_lines', `${lines} lines changed, over the limit of ${repo.auto_merge_max_lines}`);
  if (!measured && pr.paths.length < pr.files) add('files_unlisted', `GitHub listed ${pr.paths.length} of ${pr.files} changed files`);
  never.push(...pathReasons(paths, repo.auto_merge_skip));
  const gate = input.review ? reviewGate(input.review) : { never: [], wait: [] };
  never.push(...gate.never);
  const wait: MergeReason[] = [...gate.wait, ...(input.paused ? [{ kind: 'paused' as const, text: input.paused }] : [])];
  return unattendedVerdict(input, { never, wait });
}

/** What `autoMergeView` says about a task. `off`: not on. `on`: on, no PR checked yet. The rest are the last check's verdict. */
export type AutoMergeState = 'off' | 'on' | 'merge' | 'wait' | 'never';

/** A branch measured locally against the limits: the lines it changed against the base and the paths it touches. */
export interface AutoMergeMeasured {
  lines: number;
  paths: string[];
}

export interface AutoMergeView {
  state: AutoMergeState;
  /** One short phrase for a list row: "will auto-merge", "needs a person to merge: …". */
  label: string;
  /** Why it waits or needs a person; for a task with no open PR, how the branch measures against the limits. */
  reasons: string[];
  /** Where on or off comes from: the task's own setting, its repo's, or (planner) off because the repo auto-approves proposals. */
  source: 'task' | 'repo' | 'planner';
  /** When the PR refresh made the check; null when no check counts. */
  checked_at: string | null;
  /** `review`: what the review gate asks, in a repo with auto_review on; null when it is off. */
  limits: { max_lines: number; skip: string[]; tests: string; review: string | null };
}

/** What the review gate asks, as the limits say it. */
const REVIEW_LIMIT = 'a review run must read the changes and find nothing blocking, unless a person reviewed them';

const LABELS = { off: 'auto-merge off', on: 'auto-merge on', merge: 'will auto-merge' };

/**
 * What every view says about a task's auto-merge, from its setting, the check the PR refresh stored (counted only
 * while the PR is open) and its repo's limits. `measured`, for a branch with no open PR, adds how it stands against
 * the limits now. Pure: the CLI and the dashboard word it the same way.
 */
export function autoMergeView(
  task: AutoMergeSetting & { pr: PullRequest | null },
  repo: Pick<Repo, 'auto_merge' | 'auto_approve' | 'test_cmd' | 'auto_merge_max_lines' | 'auto_merge_skip' | 'auto_review'>,
  measured?: AutoMergeMeasured | null,
): AutoMergeView {
  const on = autoMergeOn(task, repo);
  const source: AutoMergeView['source'] =
    task.auto_merge !== null ? 'task' : !on && repo.auto_merge && task.source === 'planner' && repo.auto_approve ? 'planner' : 'repo';
  const skip = repo.auto_merge_skip;
  const limits = {
    max_lines: repo.auto_merge_max_lines,
    skip,
    tests: repo.test_cmd ? 'the last run must pass the tests' : 'the PR must have passing checks (the repo has no test command)',
    review: repo.auto_review ? REVIEW_LIMIT : null,
  };
  if (!on) return { state: 'off', label: LABELS.off, reasons: [], source, checked_at: null, limits };

  const open = task.pr?.state === 'open' ? task.pr : null;
  const check = open?.auto_merge_check;
  if (open && check) {
    const reasons = reasonTexts(check.reasons);
    const first = reasons[0];
    const label =
      check.verdict === 'merge'
        ? LABELS.merge
        : check.verdict === 'wait'
          ? `auto-merge waiting${first ? `: ${first}` : ''}`
          : `needs a person to merge${first ? `: ${first}` : ''}`;
    return { state: check.verdict, label, reasons, source, checked_at: open.auto_merge_checked_at, limits };
  }

  const reasons: string[] = [];
  if (measured) {
    const n = (value: number) => value.toLocaleString('en-US');
    if (measured.lines > limits.max_lines) reasons.push(`now ${n(measured.lines)} lines, over the limit of ${n(limits.max_lines)}`);
    reasons.push(...reasonTexts(pathReasons(measured.paths, skip)));
  }
  return { state: 'on', label: LABELS.on, reasons, source, checked_at: null, limits };
}
