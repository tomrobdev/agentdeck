// A PR's checks on GitHub, one by one: what `statusCheckRollup` says about each, and what is kept on the task.
import { carryFailures, failingChecks, failureLine } from './check-failures.ts';
import type { PullRequest } from './pr.ts';

/**
 * How one check stands. NEUTRAL and SKIPPED conclusions are `skipped`; only SUCCESS passed. Anything GitHub may add or
 * that this code does not know (STALE, an empty conclusion on a finished run) is `pending`: it never counts as a pass.
 */
export type CheckState = 'pass' | 'fail' | 'pending' | 'skipped';

/** One check on a PR's head commit: a GitHub check run (Actions or an app) or a commit status. */
export interface PrCheck {
  name: string;
  state: CheckState;
  /** The check's page: a check run's `detailsUrl`, a status's `targetUrl`. */
  url: string | null;
  started_at: string | null;
  completed_at: string | null;
  /**
   * Why a failing GitHub Actions check failed, read once for the head it failed on (`carryFailures`): the failed step's
   * name from the job's steps (null when GitHub named none), and its link.
   */
  step?: string | null;
  step_url?: string | null;
  /** The lines of the failed step's log that say why (`failureExcerpt`). */
  excerpt?: string;
  /** Why the log could not be read, in place of the excerpt. */
  excerpt_error?: string;
}

/** What GitHub reports about a PR's checks, counted. */
export interface CheckCounts {
  total: number;
  failing: number;
  pending: number;
  /**
   * The failing checks' names and the step each failed on (null when none was read), kept when the counts are. A stored
   * count from before this has none: its failing checks read as failing on an unknown step.
   */
  failures?: { name: string; step: string | null }[];
}

/** What the PR refresh keeps on a task (`tasks.pr_checks`): the latest checks and when they were read. */
export interface StoredChecks {
  read_at: string;
  /** The PR's head commit the checks ran on; null when GitHub didn't say. */
  head: string | null;
  checks: PrCheck[];
  /** Whether a person was told these checks fail. Stays set until they pass or a new commit comes. */
  notified: boolean;
}

/** A task's checks in a line's worth: the counts and the failing checks' names. */
export interface ChecksSummary extends CheckCounts {
  failing_names: string[];
  /** Each failing check in a line (`failureLine`): its name, the failed step and what failed. */
  failing_lines: string[];
  read_at: string;
}

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED']);
const PENDING = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED']);
const SKIPPED = new Set(['NEUTRAL', 'SKIPPED']);
const PASSED = new Set(['SUCCESS']);

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const time = (v: unknown): string | null => {
  const s = str(v);
  return s && !s.startsWith('0001-') ? s : null;
};

function stateOf(item: Record<string, unknown>): CheckState {
  const verdict = String(item.conclusion || item.state || item.status || '').toUpperCase();
  if (FAILED.has(verdict)) return 'fail';
  if (PENDING.has(verdict)) return 'pending';
  if (SKIPPED.has(verdict)) return 'skipped';
  if (PASSED.has(verdict)) return 'pass';
  return 'pending';
}

export function parseChecks(rollup: unknown): PrCheck[] {
  const items = Array.isArray(rollup) ? rollup.filter((i): i is Record<string, unknown> => !!i && typeof i === 'object') : [];
  const baseName = (item: Record<string, unknown>) => str(item.name) ?? str(item.context) ?? 'check';
  const seen = new Map<string, number>();
  for (const item of items) seen.set(baseName(item), (seen.get(baseName(item)) ?? 0) + 1);
  return items.map((item) => {
    const name = baseName(item);
    const workflow = str(item.workflowName);
    return {
      name: workflow && (seen.get(name) ?? 0) > 1 ? `${workflow} / ${name}` : name,
      state: stateOf(item),
      url: str(item.detailsUrl) ?? str(item.targetUrl),
      started_at: time(item.startedAt),
      completed_at: time(item.completedAt),
    };
  });
}

export function countOf(checks: PrCheck[]): CheckCounts {
  return {
    total: checks.length,
    failing: checks.filter((c) => c.state === 'fail').length,
    pending: checks.filter((c) => c.state === 'pending').length,
  };
}

export function countOfKept(checks: PrCheck[]): CheckCounts {
  const failing = failingChecks(checks);
  return { ...countOf(checks), ...(failing.length ? { failures: failing.map((c) => ({ name: c.name, step: c.step ?? null })) } : {}) };
}

export function checksRan(pr: { checks: CheckCounts; check_list?: PrCheck[] }): number {
  if (pr.check_list) return pr.check_list.filter((c) => c.state === 'pass' || c.state === 'fail').length;
  return pr.checks.total - pr.checks.pending;
}

export function countWithSteps(
  stored: StoredChecks | null,
  pr: { head?: string | null; check_list?: PrCheck[]; checks: CheckCounts },
): CheckCounts {
  if (!pr.check_list) return pr.checks;
  return countOfKept(carryFailures(stored, pr.head ?? null, pr.check_list).checks);
}

export const countChecks = (rollup: unknown): CheckCounts => countOf(parseChecks(rollup));

export const checksSettled = (checks: CheckCounts): boolean => checks.total > 0 && checks.pending === 0;

const checksPassed = (checks: CheckCounts): boolean => checksSettled(checks) && checks.failing === 0;

export function nextChecks(
  previous: StoredChecks | null,
  now: { head: string | null; checks: PrCheck[]; read_at: string },
): { stored: StoredChecks; notify: boolean } {
  const counts = countOf(now.checks);
  const sameCommit = !!previous && previous.head === now.head;
  const alreadyTold = sameCommit && previous.notified && !checksPassed(counts);
  const notify = counts.failing > 0 && !alreadyTold;
  return { stored: { ...now, notified: notify || alreadyTold }, notify };
}

export function checksSummary(pr: PullRequest | null): ChecksSummary | null {
  if (pr?.state !== 'open') return null;
  const stored = pr.checks.latest;
  if (!stored?.checks.length) return null;
  const failing = failingChecks(stored.checks);
  return {
    ...countOf(stored.checks),
    failing_names: failing.map((c) => c.name),
    failing_lines: failing.map(failureLine),
    read_at: stored.read_at,
  };
}
