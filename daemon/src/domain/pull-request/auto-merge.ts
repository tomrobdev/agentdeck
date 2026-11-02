// Whether the daemon may merge a done task's PR without a person (docs/plans/auto-merge.html). Pure: no I/O.
import type { Repo } from '../repo/repo.ts';
import type { Task } from '../task/task.ts';
import { parseTextList, wholeNumberError } from '../text.ts';
import { isMergeabilityUnknown } from './conflict.ts';
import { type MergeFinding, type MergeInput, conflictNeedsPerson, mergeFindings } from './merge.ts';

/** The label a PR carries while the daemon may merge it. Removing it on GitHub opts that PR out. */
export const AUTO_MERGE_LABEL = {
  name: 'agentdeck:auto-merge',
  description: 'AgentDeck merges this PR once its checks pass',
  color: '0e8a16',
};
export const DEFAULT_AUTO_MERGE_MAX_LINES = 400;
export const DEFAULT_AUTO_MERGE_SKIP = ['.github/'];

/**
 * Whether auto-merge is on for a task: its own setting, else its repo's. A planner proposal only takes the repo's
 * setting when a person approved it (the repo has auto_approve off), so no work reaches the base unseen.
 */
export function autoMergeOn(task: Pick<Task, 'auto_merge' | 'source'>, repo: Pick<Repo, 'auto_merge' | 'auto_approve'>): boolean {
  if (task.auto_merge !== null) return task.auto_merge === 1;
  return repo.auto_merge === 1 && (task.source !== 'planner' || repo.auto_approve !== 1);
}

/** The path prefixes in a repo's `auto_merge_skip`; a bad value reads as the default. */
export const autoMergeSkip = (repo: Pick<Repo, 'auto_merge_skip'>): string[] =>
  parseTextList(repo.auto_merge_skip, DEFAULT_AUTO_MERGE_SKIP);

export const autoMergeMaxLinesError = (value: unknown): string | null => wholeNumberError('auto_merge_max_lines', value, 1, 100_000);

export interface AutoMergeCheck {
  /** `merge`: go ahead. `wait`: something that can still change on its own. `never`: it needs a person. */
  verdict: 'merge' | 'wait' | 'never';
  /** Why it waits or needs a person; empty for `merge`. */
  reasons: string[];
}

/**
 * What each merge-dialog finding means when no person is there to wave it through. A draft is fine: the merge marks it
 * ready. So is BEHIND: a PR that merges cleanly onto the moved base is what GitHub would merge, and a repo that requires
 * up-to-date branches makes the merge fail, which is told once. A conflict waits for the sync the refresh starts, unless
 * the repo has auto_resolve off: then none starts and a person must sync the task.
 */
const UNATTENDED: Record<MergeFinding['kind'], 'never' | 'wait' | null> = {
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

/**
 * Whether the daemon may merge this PR now, for a task with auto-merge on: the merge dialog's findings (above), plus what
 * only auto-merge asks. Something must have tested it: the last tested run passed, or the repo has no test command and
 * the PR has CI checks. It must carry the label, stay under the repo's limits, and nothing may be paused.
 */
export function autoMergeCheck(
  input: MergeInput & {
    repo: Pick<Repo, 'test_cmd' | 'auto_merge_max_lines' | 'auto_merge_skip'>;
    /** Why the daemon or the repo is paused; null when neither is. */
    paused: string | null;
  },
): AutoMergeCheck {
  const { repo, pr, tests_passed } = input;
  const reasons = { never: [] as string[], wait: [] as string[] };
  for (const f of mergeFindings(input)) {
    // While required checks run GitHub says BLOCKED too; the pending checks are the wait.
    const how =
      f.kind === 'blocked' && pr.checks.pending ? null : f.kind === 'conflict' && conflictNeedsPerson(input) ? 'never' : UNATTENDED[f.kind];
    if (how) reasons[how].push(f.text);
  }

  if (!pr.labels.includes(AUTO_MERGE_LABEL.name)) reasons.never.push(`the PR has no ${AUTO_MERGE_LABEL.name} label`);
  if (repo.test_cmd && tests_passed === null) reasons.never.push('the tests have not run');
  if (!repo.test_cmd && tests_passed === null && !pr.checks.total)
    reasons.never.push('nothing tested it: the repo has no test command and the PR no checks');
  const lines = pr.additions + pr.deletions;
  if (lines > repo.auto_merge_max_lines) reasons.never.push(`${lines} lines changed, over the limit of ${repo.auto_merge_max_lines}`);
  if (pr.paths.length < pr.files) reasons.never.push(`GitHub listed ${pr.paths.length} of ${pr.files} changed files`);
  const skip = autoMergeSkip(repo);
  const skipped = pr.paths.filter((path) => skip.some((prefix) => path.startsWith(prefix)));
  if (skipped.length)
    reasons.never.push(`touches ${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? ` and ${skipped.length - 3} more` : ''}`);

  if (isMergeabilityUnknown(pr)) reasons.wait.push('GitHub is still working out whether it merges cleanly');
  if (input.paused) reasons.wait.push(input.paused);

  if (reasons.never.length) return { verdict: 'never', reasons: reasons.never };
  if (reasons.wait.length) return { verdict: 'wait', reasons: reasons.wait };
  return { verdict: 'merge', reasons: [] };
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
  limits: { max_lines: number; skip: string[]; tests: string };
}

/** The stored check, or null when it is missing or unreadable. */
export function readAutoMergeCheck(json: string | null): AutoMergeCheck | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Partial<AutoMergeCheck> | null;
    if (!v || !['merge', 'wait', 'never'].includes(v.verdict as string) || !Array.isArray(v.reasons)) return null;
    return { verdict: v.verdict!, reasons: v.reasons.filter((r): r is string => typeof r === 'string') };
  } catch {
    return null;
  }
}

const LABELS = { off: 'auto-merge off', on: 'auto-merge on', merge: 'will auto-merge' };

/**
 * What every view says about a task's auto-merge, from its setting, the check the PR refresh stored (counted only
 * while the PR is open) and its repo's limits. `measured`, for a branch with no open PR, adds how it stands against
 * the limits now. Pure: the CLI and the dashboard word it the same way.
 */
export function autoMergeView(
  task: Pick<Task, 'auto_merge' | 'source' | 'pr_state' | 'auto_merge_check' | 'auto_merge_checked_at'>,
  repo: Pick<Repo, 'auto_merge' | 'auto_approve' | 'test_cmd' | 'auto_merge_max_lines' | 'auto_merge_skip'>,
  measured?: AutoMergeMeasured | null,
): AutoMergeView {
  const on = autoMergeOn(task, repo);
  const source: AutoMergeView['source'] =
    task.auto_merge !== null
      ? 'task'
      : !on && repo.auto_merge === 1 && task.source === 'planner' && repo.auto_approve === 1
        ? 'planner'
        : 'repo';
  const skip = autoMergeSkip(repo);
  const limits = {
    max_lines: repo.auto_merge_max_lines,
    skip,
    tests: repo.test_cmd ? 'the last run must pass the tests' : 'the PR must have passing checks (the repo has no test command)',
  };
  if (!on) return { state: 'off', label: LABELS.off, reasons: [], source, checked_at: null, limits };

  const check = task.pr_state === 'open' ? readAutoMergeCheck(task.auto_merge_check) : null;
  if (check) {
    const first = check.reasons[0];
    const label =
      check.verdict === 'merge'
        ? LABELS.merge
        : check.verdict === 'wait'
          ? `auto-merge waiting${first ? `: ${first}` : ''}`
          : `needs a person to merge${first ? `: ${first}` : ''}`;
    return { state: check.verdict, label, reasons: check.reasons, source, checked_at: task.auto_merge_checked_at, limits };
  }

  const reasons: string[] = [];
  if (measured) {
    const n = (value: number) => value.toLocaleString('en-US');
    if (measured.lines > limits.max_lines) reasons.push(`now ${n(measured.lines)} lines, over the limit of ${n(limits.max_lines)}`);
    const skipped = measured.paths.filter((path) => skip.some((prefix) => path.startsWith(prefix)));
    if (skipped.length)
      reasons.push(`touches ${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? ` and ${skipped.length - 3} more` : ''}`);
  }
  return { state: 'on', label: LABELS.on, reasons, source, checked_at: null, limits };
}
