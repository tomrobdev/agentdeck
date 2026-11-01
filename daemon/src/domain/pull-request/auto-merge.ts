// Whether the daemon may merge a done task's PR without a person (docs/plans/auto-merge.html). Pure: no I/O.
import type { Repo } from '../repo/repo.ts';
import type { Task } from '../task/task.ts';
import { parseTextList, wholeNumberError } from '../text.ts';
import { isMergeabilityUnknown } from './conflict.ts';
import { type MergeFinding, type MergeInput, mergeFindings } from './merge.ts';

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
 * up-to-date branches makes the merge fail, which is told once. A conflict waits for the sync the refresh starts.
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
    const how = f.kind === 'blocked' && pr.checks.pending ? null : UNATTENDED[f.kind];
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
  const held = pr.paths.filter((path) => skip.some((prefix) => path.startsWith(prefix)));
  if (held.length) reasons.never.push(`touches ${held.slice(0, 3).join(', ')}${held.length > 3 ? ` and ${held.length - 3} more` : ''}`);

  if (isMergeabilityUnknown(pr)) reasons.wait.push('GitHub is still working out whether it merges cleanly');
  if (input.paused) reasons.wait.push(input.paused);

  if (reasons.never.length) return { verdict: 'never', reasons: reasons.never };
  if (reasons.wait.length) return { verdict: 'wait', reasons: reasons.wait };
  return { verdict: 'merge', reasons: [] };
}
