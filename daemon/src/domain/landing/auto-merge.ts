// Whether the daemon may merge a done task's PR without a person (docs/plans/auto-merge.html). Pure: no I/O.
import type { Repo } from '../repos/index.ts';
import { PROTECTED_PREFIXES, isProtectedPath } from '../repos/index.ts';
import { wholeNumberError } from '../shared/index.ts';
import { checksRan } from './checks.ts';
import { isMergeabilityUnknown } from './conflict.ts';
import { type MergeFinding, type MergeInput, conflictNeedsPerson, mergeFindings } from './merge.ts';
import type { PullRequest } from './pr.ts';

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
export function pathReasons(paths: string[], skip: string[]): string[] {
  const protectedPaths = paths.filter(isProtectedPath);
  const skipped = paths.filter((path) => !isProtectedPath(path) && skip.some((prefix) => path.startsWith(prefix)));
  return [
    ...(protectedPaths.length
      ? [`changes ${someOf(protectedPaths)}: files under ${PROTECTED_PREFIXES.join(', ')} steer every later agent`]
      : []),
    ...(skipped.length ? [`touches ${someOf(skipped)}`] : []),
  ];
}

export const autoMergeMaxLinesError = (value: unknown): string | null => wholeNumberError('auto_merge_max_lines', value, 1, 100_000);

export interface AutoMergeCheck {
  /** `merge`: go ahead. `wait`: something that can still change on its own. `never`: it needs a person. */
  verdict: 'merge' | 'wait' | 'never';
  /** Why it waits or needs a person; empty for `merge`. */
  reasons: string[];
  /** Set when one of the reasons is the merge finding of kind `conflict`: the branch conflicts with the base. */
  conflict?: true;
}

/** A verdict from its reasons, marked when one of the findings was a conflict with the base. */
export function verdictOf(reasons: { never: string[]; wait: string[] }, found: MergeFinding[]): AutoMergeCheck {
  const check: AutoMergeCheck = reasons.never.length
    ? { verdict: 'never', reasons: reasons.never }
    : reasons.wait.length
      ? { verdict: 'wait', reasons: reasons.wait }
      : { verdict: 'merge', reasons: [] };
  if (check.verdict !== 'merge' && found.some((f) => f.kind === 'conflict')) check.conflict = true;
  return check;
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
 * a CI check ran on the PR (passed or failed; skipped and neutral ones tested nothing). It must carry the label, stay
 * under the repo's limits, and nothing may be paused. The size is `measured` from git when the branch could be measured
 * at the PR's head; otherwise it is GitHub's, whose file list stops at 100, so a longer one needs a person.
 */
export function autoMergeCheck(
  input: MergeInput & {
    repo: Pick<Repo, 'test_cmd' | 'auto_merge_max_lines' | 'auto_merge_skip'>;
    /** Why the daemon or the repo is paused; null when neither is. */
    paused: string | null;
    /** The branch measured locally (`git diff --numstat` against the base); null or missing when it couldn't be. */
    measured?: AutoMergeMeasured | null;
  },
): AutoMergeCheck {
  const { repo, pr, tests_passed } = input;
  const reasons = { never: [] as string[], wait: [] as string[] };
  const found = mergeFindings(input);
  for (const f of found) {
    // While required checks run GitHub says BLOCKED too; the pending checks are the wait.
    const how =
      f.kind === 'blocked' && pr.checks.pending ? null : f.kind === 'conflict' && conflictNeedsPerson(input) ? 'never' : UNATTENDED[f.kind];
    if (how) reasons[how].push(f.text);
  }

  if (!pr.labels.includes(AUTO_MERGE_LABEL.name)) reasons.never.push(`the PR has no ${AUTO_MERGE_LABEL.name} label`);
  if (repo.test_cmd && tests_passed === null) reasons.never.push('the tests have not run');
  // A check that ran counts, not one skipped or neutral; one still running is the wait its finding says.
  if (!repo.test_cmd && tests_passed === null && !checksRan(pr) && !pr.checks.pending)
    reasons.never.push('nothing tested it: the repo has no test command and no check ran on the PR');
  const { measured } = input;
  const lines = measured ? measured.lines : pr.additions + pr.deletions;
  const paths = measured ? measured.paths : pr.paths;
  if (lines > repo.auto_merge_max_lines) reasons.never.push(`${lines} lines changed, over the limit of ${repo.auto_merge_max_lines}`);
  if (!measured && pr.paths.length < pr.files) reasons.never.push(`GitHub listed ${pr.paths.length} of ${pr.files} changed files`);
  reasons.never.push(...pathReasons(paths, repo.auto_merge_skip));

  if (isMergeabilityUnknown(pr)) reasons.wait.push('GitHub is still working out whether it merges cleanly');
  if (input.paused) reasons.wait.push(input.paused);
  return verdictOf(reasons, found);
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

const LABELS = { off: 'auto-merge off', on: 'auto-merge on', merge: 'will auto-merge' };

/**
 * What every view says about a task's auto-merge, from its setting, the check the PR refresh stored (counted only
 * while the PR is open) and its repo's limits. `measured`, for a branch with no open PR, adds how it stands against
 * the limits now. Pure: the CLI and the dashboard word it the same way.
 */
export function autoMergeView(
  task: AutoMergeSetting & { pr: PullRequest | null },
  repo: Pick<Repo, 'auto_merge' | 'auto_approve' | 'test_cmd' | 'auto_merge_max_lines' | 'auto_merge_skip'>,
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
  };
  if (!on) return { state: 'off', label: LABELS.off, reasons: [], source, checked_at: null, limits };

  const open = task.pr?.state === 'open' ? task.pr : null;
  const check = open?.auto_merge_check;
  if (open && check) {
    const first = check.reasons[0];
    const label =
      check.verdict === 'merge'
        ? LABELS.merge
        : check.verdict === 'wait'
          ? `auto-merge waiting${first ? `: ${first}` : ''}`
          : `needs a person to merge${first ? `: ${first}` : ''}`;
    return { state: check.verdict, label, reasons: check.reasons, source, checked_at: open.auto_merge_checked_at, limits };
  }

  const reasons: string[] = [];
  if (measured) {
    const n = (value: number) => value.toLocaleString('en-US');
    if (measured.lines > limits.max_lines) reasons.push(`now ${n(measured.lines)} lines, over the limit of ${n(limits.max_lines)}`);
    reasons.push(...pathReasons(measured.paths, skip));
  }
  return { state: 'on', label: LABELS.on, reasons, source, checked_at: null, limits };
}
