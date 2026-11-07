// A PR's checks on GitHub, one by one: what `statusCheckRollup` says about each, what is kept on the task, and the note that
// sends the failures back to the worker. What a person is told when they fail is in domain/operations/notification.ts. Pure: no I/O.
import { plural } from '../shared/text.ts';
import type { PullRequest } from './pr.ts';

/** How one check stands. NEUTRAL and SKIPPED conclusions are `skipped`; anything not failing or pending passed. */
export type CheckState = 'pass' | 'fail' | 'pending' | 'skipped';

/** One check on a PR's head commit: a GitHub check run (Actions or an app) or a commit status. */
export interface PrCheck {
  name: string;
  state: CheckState;
  /** The check's page: a check run's `detailsUrl`, a status's `targetUrl`. */
  url: string | null;
  started_at: string | null;
  completed_at: string | null;
}

/** What GitHub reports about a PR's checks, counted. */
export interface CheckCounts {
  total: number;
  failing: number;
  pending: number;
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
  read_at: string;
}

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED']);
const PENDING = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED']);
const SKIPPED = new Set(['NEUTRAL', 'SKIPPED']);

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
/** A check's time; GitHub gives a check run that hasn't started or finished the zero time, 0001-01-01. */
const time = (v: unknown): string | null => {
  const s = str(v);
  return s && !s.startsWith('0001-') ? s : null;
};

function stateOf(item: Record<string, unknown>): CheckState {
  const verdict = String(item.conclusion || item.state || item.status || '').toUpperCase();
  if (FAILED.has(verdict)) return 'fail';
  if (PENDING.has(verdict)) return 'pending';
  if (SKIPPED.has(verdict)) return 'skipped';
  return 'pass';
}

/**
 * Read each `statusCheckRollup` entry. A check run has `name`, `workflowName`, `status`, `conclusion`, `detailsUrl`,
 * `startedAt` and `completedAt`; a commit status has `context`, `state`, `targetUrl` (and maybe `startedAt`). Check runs
 * that share a name (two workflows each with a `test` job) are told apart by their workflow: "CI / test".
 */
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

/** Count checks: every one, the failing ones and the pending ones. */
export function countOf(checks: PrCheck[]): CheckCounts {
  return {
    total: checks.length,
    failing: checks.filter((c) => c.state === 'fail').length,
    pending: checks.filter((c) => c.state === 'pending').length,
  };
}

/** Count `statusCheckRollup` entries: check runs have `status` and `conclusion`, commit statuses have `state`. */
export const countChecks = (rollup: unknown): CheckCounts => countOf(parseChecks(rollup));

/** Whether the checks have run their course: there are some, and none is pending. No checks yet may only mean CI hasn't started. */
export const checksSettled = (checks: CheckCounts): boolean => checks.total > 0 && checks.pending === 0;

/** Whether the checks all passed: settled, and none failing. */
const checksPassed = (checks: CheckCounts): boolean => checksSettled(checks) && checks.failing === 0;

/**
 * What a PR refresh keeps, and whether to tell a person the checks failed. A person hears once when the checks go from
 * not failing to failing, and again only after they all passed or a new commit came (a re-run still failing says nothing).
 */
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

/** The checks summary a task view shows: null when the PR isn't open or has no checks. */
export function checksSummary(pr: PullRequest | null): ChecksSummary | null {
  if (pr?.state !== 'open') return null;
  const stored = pr.checks.latest;
  if (!stored?.checks.length) return null;
  return { ...countOf(stored.checks), failing_names: failingChecks(stored.checks).map((c) => c.name), read_at: stored.read_at };
}

export const failingChecks = (checks: PrCheck[]): PrCheck[] => checks.filter((c) => c.state === 'fail');

/** The GitHub Actions run (and job) a check's link points at, or null for a check that isn't from Actions. */
export function actionsRun(url: string | null): { run: string; job: string | null } | null {
  const m = url?.match(/^https:\/\/[^/]+\/[^/]+\/[^/]+\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/);
  return m ? { run: m[1], job: m[2] ?? null } : null;
}

/** Lines kept from the end of each failing check's log, and the bytes kept across all of them. */
export const LOG_TAIL_LINES = 60;
export const LOG_TAIL_BYTES = 8 * 1024;

/** The last `lines` lines of a log, cut from the front to at most `bytes` bytes. */
export function logTail(log: string, lines = LOG_TAIL_LINES, bytes = LOG_TAIL_BYTES): string {
  const size = (s: string) => new TextEncoder().encode(s).length;
  let tail = log.replace(/\s+$/, '').split('\n').slice(-lines).join('\n');
  while (size(tail) > bytes) {
    const cut = tail.indexOf('\n');
    tail = cut === -1 ? tail.slice(tail.length - bytes) : tail.slice(cut + 1);
  }
  return tail;
}

/** One failing check as the worker hears it: its name and link, and its log's tail when there is one. */
export interface FailedCheck {
  name: string;
  url: string | null;
  /** The tail of the failed steps' log (GitHub Actions only). */
  log?: string;
  /** Why the log could not be read. */
  log_error?: string;
}

/** The retry note that sends a PR's failing checks back to the worker. */
export function fixChecksNote(failed: FailedCheck[]): string {
  const parts = [
    'CI checks failed on the PR',
    '',
    `${plural(failed.length, 'check')} failed on GitHub. Find out why, fix it on this branch, and run the tests again. The PR updates when the run finishes.`,
  ];
  for (const c of failed) {
    parts.push('', `### ${c.name}${c.url ? ` (${c.url})` : ''}`);
    if (c.log) parts.push('Last lines of the failed steps:', '```', c.log, '```');
    else if (c.log_error) parts.push(`The log could not be read: ${c.log_error}`);
    else parts.push('Not a GitHub Actions check: open its link to see why it failed.');
  }
  return parts.join('\n');
}
