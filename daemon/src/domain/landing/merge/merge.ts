// Whether a PR can be merged, and how.
import { isConflicting, isMergeabilityUnknown } from '#domain/landing/merge/conflict.ts';
import { type PrState, parsePrState } from '#domain/landing/pull-request/pr.ts';
import { type CheckCounts, type PrCheck, countOf, parseChecks } from '#domain/landing/pull-request/checks.ts';
import { type JobStep, failingChecks, failureLine, failureRead } from '#domain/landing/pull-request/check-failures.ts';
import { type JobStart, ciNotRunMessages, ciNotRunText } from '#domain/landing/pull-request/ci-not-run.ts';
import { plural } from '#domain/shared/index.ts';

export { type CheckCounts, checksSettled, countChecks } from '#domain/landing/pull-request/checks.ts';

/** A pull request to open. */
export interface CreatePr {
  cwd: string; // the task's worktree
  base: string;
  head: string;
  title: string;
  body: string;
  draft: boolean;
  labels?: string[];
}

/** What `gh pr view` says about a PR that decides whether and how it merges. */
export interface PrDetails {
  /** GitHub's `state`, as the daemon names it. */
  state: PrState;
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
  /** Each check, as `checks` counts them. Missing where a caller made the details up. */
  check_list?: PrCheck[];
  /** The PR's head commit (`headRefOid`); null when GitHub didn't say. */
  head?: string | null;
  /** The changed files' paths, and the labels; empty unless asked for (`prDetails`'s `withFiles`). */
  paths: string[];
  labels: string[];
  body?: string | null;
}

export function parsePrDetails(json: string): PrDetails {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const state = parsePrState(String(raw.state ?? ''));
  if (!state) throw new Error(`unexpected PR state ${JSON.stringify(raw.state ?? null)}`);
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  const names = (v: unknown, key: string) =>
    Array.isArray(v) ? v.map((item) => (item as Record<string, unknown>)?.[key]).filter((n): n is string => typeof n === 'string') : [];
  const check_list = parseChecks(raw.statusCheckRollup);
  return {
    state,
    draft: raw.isDraft === true,
    mergeable: String(raw.mergeable ?? 'UNKNOWN'),
    merge_state: String(raw.mergeStateStatus ?? 'UNKNOWN'),
    commits: Array.isArray(raw.commits) ? raw.commits.length : num(raw.commits),
    files: num(raw.changedFiles),
    additions: num(raw.additions),
    deletions: num(raw.deletions),
    checks: countOf(check_list),
    check_list,
    head: typeof raw.headRefOid === 'string' && raw.headRefOid ? raw.headRefOid : null,
    paths: names(raw.files, 'path'),
    labels: names(raw.labels, 'name'),
    body: typeof raw.body === 'string' ? raw.body : null,
  };
}

export function parseJobSteps(json: string): JobStep[] {
  const raw = JSON.parse(json) as { steps?: unknown };
  if (!Array.isArray(raw.steps)) return [];
  return raw.steps
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && typeof s.name === 'string')
    .map((s) => ({
      name: s.name as string,
      number: typeof s.number === 'number' ? s.number : 0,
      conclusion: typeof s.conclusion === 'string' ? s.conclusion : null,
    }));
}

export function parseJobStart(json: string): JobStart {
  const raw = JSON.parse(json) as { runner_name?: unknown; steps?: unknown };
  return {
    runner_name: typeof raw.runner_name === 'string' && raw.runner_name ? raw.runner_name : null,
    steps: Array.isArray(raw.steps) ? raw.steps.length : 0,
  };
}

export function parseAnnotations(json: string): string[] {
  const raw = JSON.parse(json) as unknown;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((a) => {
    const message = (a as Record<string, unknown> | null)?.message;
    return typeof message === 'string' && message.trim() ? [message.trim()] : [];
  });
}

/** A PR `gh pr list --head <branch>` lists. */
export interface BranchPr {
  url: string;
  state: Exclude<PrState, 'failed'>;
}

export function parseBranchPrs(json: string): BranchPr[] {
  const raw = JSON.parse(json) as unknown;
  if (!Array.isArray(raw)) throw new Error('gh pr list did not answer with a list');
  return raw.flatMap((item) => {
    const r = (item ?? {}) as Record<string, unknown>;
    const state = parsePrState(String(r.state ?? ''));
    return typeof r.url === 'string' && r.url && state && state !== 'failed' ? [{ url: r.url, state }] : [];
  });
}

/** One fact about a PR that bears on merging it. A problem stops any merge; anything else is a warning a person may wave through. */
export interface MergeFinding {
  kind:
    | 'not_open'
    | 'lands_after'
    | 'conflict'
    | 'draft'
    | 'behind'
    | 'blocked'
    | 'tests_failed'
    | 'checks_failing'
    | 'checks_pending'
    | 'ci_not_run';
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
  /** Whether the last run that ran the tests passed them; null when none did. */
  tests_passed: boolean | null;
  /** The tasks this one lands after that have not landed (`unlandedAfter`), each with why. Missing means none. */
  lands_after?: { on: number; reason: string }[];
  /** False when the repo has auto_resolve off: no sync starts on its own, so a conflict needs a person. Missing means on. */
  auto_resolve?: boolean;
  /**
   * The repo's ci_not_run_ok: when on and the last tested run passed, a GitHub check that never started does not stop a
   * merge without a person. Missing means off.
   */
  ci_not_run_ok?: boolean;
}

const ciNotRunWaived = (input: Pick<MergeInput, 'ci_not_run_ok' | 'tests_passed'>): boolean =>
  input.ci_not_run_ok === true && input.tests_passed === true;

export const conflictNeedsPerson = (input: Pick<MergeInput, 'auto_resolve'>): boolean => input.auto_resolve === false;

export const mergeSyncsFirst = (input: MergeInput): boolean => {
  const problems = mergeFindings(input).filter((f) => f.problem);
  return problems.length > 0 && problems.every((f) => f.kind === 'conflict') && !conflictNeedsPerson(input);
};

export const syncingFirstLine = (base: string): string =>
  `conflicts with ${base}: syncing, it merges once the sync is clean and the tests pass`;

function failingDetail(checks: PrCheck[] | undefined): string {
  const failing = failingChecks(checks ?? []);
  return failing.some(failureRead) ? `: ${failing.map(failureLine).join('; ')}` : '';
}

export function mergeFindings({ pr_state, pr, tests_passed, lands_after = [], auto_resolve }: MergeInput): MergeFinding[] {
  const found: MergeFinding[] = [];
  const add = (kind: MergeFinding['kind'], text: string, problem = false) => found.push({ kind, problem, text });
  if (pr_state !== 'open') add('not_open', `the PR is ${pr_state ?? 'not open'}`, true);
  for (const unlanded of lands_after) add('lands_after', `lands after #${unlanded.on}: ${unlanded.reason}`, true);
  if (isConflicting(pr))
    add(
      'conflict',
      conflictNeedsPerson({ auto_resolve })
        ? 'the branch has conflicts with the base branch, and the repo has auto_resolve off: sync the task (agentdeck sync, or Sync in the dashboard)'
        : 'the branch has conflicts with the base branch',
      true,
    );
  if (pr.draft) add('draft', 'the PR is a draft; it will be marked ready for review first');
  if (pr.merge_state === 'BEHIND') add('behind', 'the base branch has moved on since the branch was cut');
  if (pr.merge_state === 'BLOCKED' && !pr.draft)
    add('blocked', 'GitHub says branch protection may block this merge (required reviews or checks)');
  if (tests_passed === false) add('tests_failed', 'tests failed on the last run');
  if (pr.checks.failing) add('checks_failing', `${plural(pr.checks.failing, 'check')} failing on GitHub${failingDetail(pr.check_list)}`);
  if (pr.checks.pending) add('checks_pending', `${plural(pr.checks.pending, 'check')} still running on GitHub`);
  const notRun = ciNotRunMessages(pr.check_list ?? []);
  if (notRun.length) add('ci_not_run', ciNotRunText(notRun));
  return found;
}

/**
 * What a failed merge means for trying again. `head_moved`: GitHub refused because the PR's head is no longer the commit
 * that was judged; the next refresh judges the new one. `transient`: something that passes on its own (the base moved
 * under a merge round, GitHub answered 5xx, the call timed out). `lasting`: a refusal that stays until a person acts.
 */
export type MergeFailure = 'head_moved' | 'transient' | 'lasting';

const MERGE_FAILURES: { failure: Exclude<MergeFailure, 'lasting'>; when: RegExp }[] = [
  { failure: 'head_moved', when: /head branch was modified|expected head (?:sha|oid)|head (?:sha|oid|commit)\b[^.]*\bmatch/i },
  { failure: 'transient', when: /base branch was modified/i },
  { failure: 'transient', when: /\bHTTP 5\d\d\b|bad gateway|service unavailable|gateway time-?out|internal server error/i },
  { failure: 'transient', when: /timed out|\btimeout\b|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|connection reset/i },
];

export const mergeFailure = (message: string): MergeFailure => MERGE_FAILURES.find((f) => f.when.test(message))?.failure ?? 'lasting';

export function mergeCheck(input: MergeInput): MergeCheck {
  const found = mergeFindings(input);
  return { problems: found.filter((f) => f.problem).map((f) => f.text), warnings: found.filter((f) => !f.problem).map((f) => f.text) };
}

/**
 * What a reason a merge waits or needs a person is about: a merge finding's kind, GitHub still working out mergeability,
 * one of the rules only auto-merge asks (`no_label`, `tests_not_run`, `untested`, `too_many_lines`, `too_many_code_comments`, `files_unlisted`,
 * `protected_paths`, `skipped_paths`, `paused`), its review gate in a repo with auto_review on (`review_pending`,
 * `review_blocking`, `review_failed`, `review_unread`, `review_unanswered`: review-gate.ts), or `other`: a reason stored
 * before reasons had kinds.
 */
export type MergeReasonKind =
  | MergeFinding['kind']
  | 'mergeability_unknown'
  | 'no_label'
  | 'one_way_door'
  | 'no_door'
  | 'tests_not_run'
  | 'untested'
  | 'too_many_lines'
  | 'too_many_code_comments'
  | 'files_unlisted'
  | 'protected_paths'
  | 'skipped_paths'
  | 'paused'
  | 'review_pending'
  | 'review_blocking'
  | 'review_failed'
  | 'review_unread'
  | 'review_unanswered'
  | 'other';

/** One reason a merge waits or needs a person: what it is about, and how a person reads it. */
export interface MergeReason {
  kind: MergeReasonKind;
  text: string;
  /** A short tag for a list row, where the reason has one (`code comments +12 (8%)`). */
  tag?: string;
}

/** The reasons a merge needs a person (`never`) and those it waits for (`wait`), each in the order they are told. */
export interface MergeReasons {
  never: MergeReason[];
  wait: MergeReason[];
}

/** Whether a merge goes ahead, waits or needs a person, and why: auto-merge's check, or a merge request's. */
export interface AutoMergeCheck {
  /** `merge`: go ahead. `wait`: something that can still change on its own. `never`: it needs a person. */
  verdict: 'merge' | 'wait' | 'never';
  /** Why it waits or needs a person; empty for `merge`. */
  reasons: MergeReason[];
  /** Set when one of the reasons is the merge finding of kind `conflict`: the branch conflicts with the base. */
  conflict?: true;
}

export function verdictOf(reasons: MergeReasons, found: MergeFinding[]): AutoMergeCheck {
  const check: AutoMergeCheck = reasons.never.length
    ? { verdict: 'never', reasons: reasons.never }
    : reasons.wait.length
      ? { verdict: 'wait', reasons: reasons.wait }
      : { verdict: 'merge', reasons: [] };
  if (check.verdict !== 'merge' && found.some((f) => f.kind === 'conflict')) check.conflict = true;
  return check;
}

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
  ci_not_run: 'never',
};

function unattended(f: MergeFinding, input: MergeInput): 'never' | 'wait' | null {
  if (f.kind === 'ci_not_run' && ciNotRunWaived(input)) return null;
  if (f.kind === 'blocked' && input.pr.checks.pending) return null;
  if (f.kind === 'conflict' && conflictNeedsPerson(input)) return 'never';
  return UNATTENDED[f.kind];
}

export function unattendedVerdict(input: MergeInput, extra: Partial<MergeReasons> = {}): AutoMergeCheck {
  const reasons: MergeReasons = { never: [], wait: [] };
  const found = mergeFindings(input);
  for (const f of found) {
    const how = unattended(f, input);
    if (how) reasons[how].push({ kind: f.kind, text: f.text });
  }
  reasons.never.push(...(extra.never ?? []));
  if (isMergeabilityUnknown(input.pr))
    reasons.wait.push({ kind: 'mergeability_unknown', text: 'GitHub is still working out whether it merges cleanly' });
  reasons.wait.push(...(extra.wait ?? []));
  return verdictOf(reasons, found);
}

/** What a check says to a person: its verdict and reasons as text, as the API and the CLI show them. */
export interface MergeVerdictView {
  verdict: AutoMergeCheck['verdict'];
  reasons: string[];
  conflict?: true;
}

export function verdictView(check: AutoMergeCheck): MergeVerdictView {
  return { ...check, reasons: reasonTexts(check.reasons) };
}

export const reasonTexts = (reasons: MergeReason[]): string[] => reasons.map((r) => r.text);
