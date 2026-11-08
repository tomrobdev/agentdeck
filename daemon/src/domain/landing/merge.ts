// Whether a PR can be merged, and how. Pure: no I/O.
import { isConflicting } from './conflict.ts';
import { type PrState, parsePrState } from './pr.ts';
import { type CheckCounts, type JobStep, type PrCheck, countOf, failingChecks, failureLine, failureRead, parseChecks } from './checks.ts';
import { plural } from '../shared/index.ts';

export { type CheckCounts, checksSettled, countChecks } from './checks.ts';

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
}

/** Read `gh pr view --json state,headRefOid,isDraft,mergeable,mergeStateStatus,commits,additions,deletions,changedFiles,statusCheckRollup,files,labels`. */
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
  };
}

/** Read the steps of `gh api repos/{owner}/{repo}/actions/jobs/<id>`: a GitHub Actions job's steps and how each ended. */
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

/** A PR `gh pr list --head <branch>` lists. */
export interface BranchPr {
  url: string;
  state: Exclude<PrState, 'failed'>;
}

/** Read `gh pr list --head <branch> --state all --json url,state`; an entry without a url or a known state is left out. */
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
  kind: 'not_open' | 'lands_after' | 'conflict' | 'draft' | 'behind' | 'blocked' | 'tests_failed' | 'checks_failing' | 'checks_pending';
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
}

/** Whether a conflict with the base is left to a person: the repo has auto_resolve off, so the daemon never syncs it. */
export const conflictNeedsPerson = (input: Pick<MergeInput, 'auto_resolve'>): boolean => input.auto_resolve === false;

/** What failed, once the PR refresh read why a failing check failed: ": check › step: what failed; …". Empty until then. */
function failingDetail(checks: PrCheck[] | undefined): string {
  const failing = failingChecks(checks ?? []);
  return failing.some(failureRead) ? `: ${failing.map(failureLine).join('; ')}` : '';
}

/** What about a PR's state bears on merging it, in the order the merge dialog shows it. */
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
  return found;
}

/**
 * What a failed merge means for trying again. `head_moved`: GitHub refused because the PR's head is no longer the commit
 * that was judged; the next refresh judges the new one. `transient`: something that passes on its own (the base moved
 * under a merge round, GitHub answered 5xx, the call timed out). `lasting`: a refusal that stays until a person acts.
 */
export type MergeFailure = 'head_moved' | 'transient' | 'lasting';

/** The failures that pass on their own, by what `gh pr merge` says. Anything else is `lasting`. */
const MERGE_FAILURES: { failure: Exclude<MergeFailure, 'lasting'>; when: RegExp }[] = [
  { failure: 'head_moved', when: /head branch was modified|expected head (?:sha|oid)|head (?:sha|oid|commit)\b[^.]*\bmatch/i },
  { failure: 'transient', when: /base branch was modified/i },
  { failure: 'transient', when: /\bHTTP 5\d\d\b|bad gateway|service unavailable|gateway time-?out|internal server error/i },
  { failure: 'transient', when: /timed out|\btimeout\b|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|connection reset/i },
];

/** What a failed merge's error message means for trying again (`MergeFailure`). */
export const mergeFailure = (message: string): MergeFailure => MERGE_FAILURES.find((f) => f.when.test(message))?.failure ?? 'lasting';

/** Turn a PR's state into blocking problems and warnings. */
export function mergeCheck(input: MergeInput): MergeCheck {
  const found = mergeFindings(input);
  return { problems: found.filter((f) => f.problem).map((f) => f.text), warnings: found.filter((f) => !f.problem).map((f) => f.text) };
}
