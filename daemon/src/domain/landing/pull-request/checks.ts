// A PR's checks on GitHub, one by one: what `statusCheckRollup` says about each, what is kept on the task, and the note that sends the failures back to the worker.
import { plural } from '../../shared/index.ts';
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

export const failingChecks = (checks: PrCheck[]): PrCheck[] => checks.filter((c) => c.state === 'fail');

export function actionsRun(url: string | null): { run: string; job: string | null } | null {
  const m = url?.match(/^https:\/\/[^/]+\/[^/]+\/[^/]+\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/);
  return m ? { run: m[1], job: m[2] ?? null } : null;
}

export const LOG_TAIL_LINES = 60;
export const LOG_TAIL_BYTES = 8 * 1024;

export function logTail(log: string, lines = LOG_TAIL_LINES, bytes = LOG_TAIL_BYTES): string {
  const size = (s: string) => new TextEncoder().encode(s).length;
  let tail = log.replace(/\s+$/, '').split('\n').slice(-lines).join('\n');
  while (size(tail) > bytes) {
    const cut = tail.indexOf('\n');
    tail = cut === -1 ? lastBytes(tail, bytes) : tail.slice(cut + 1);
  }
  return tail;
}

function lastBytes(s: string, bytes: number): string {
  const encoded = new TextEncoder().encode(s);
  let start = Math.max(0, encoded.length - Math.max(0, bytes));
  while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(encoded.subarray(start));
}

export function headBytes(text: string, bytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= bytes) return text;
  const kept: string[] = [];
  let size = 0;
  for (const line of text.split('\n')) {
    const next = size + encoder.encode(line).length + (kept.length ? 1 : 0);
    if (next > bytes) break;
    kept.push(line);
    size = next;
  }
  if (kept.length) return kept.join('\n');
  const encoded = encoder.encode(text);
  let end = Math.max(0, bytes);
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(encoded.subarray(0, end));
}

/** One step of a GitHub Actions job, as `gh api repos/{owner}/{repo}/actions/jobs/<id>` lists it. */
export interface JobStep {
  name: string;
  number: number;
  /** `success`, `failure`, `skipped`, …; null while it runs. */
  conclusion: string | null;
}

export function failedStep(steps: JobStep[]): JobStep | null {
  return steps.find((s) => ['failure', 'timed_out', 'cancelled'].includes(s.conclusion?.toLowerCase() ?? '')) ?? null;
}

export function stepUrl(jobUrl: string | null, step: JobStep | null): string | null {
  return jobUrl && step?.number ? `${jobUrl.replace(/#.*$/, '')}#step:${step.number}:1` : null;
}

export const EXCERPT_BYTES = 4 * 1024;

const MARKERS: { at: RegExp; weak?: true }[] = [
  { at: /^\s*✖/ },
  { at: /\berror TS\d+/ },
  { at: /^\[warn\]/ },
  { at: /^\s*error\[/ },
  { at: /\bbelow its floor\b/ },
  { at: /^[a-z]_[a-z_]+\s+[1-9]\d*\s/ },
  { at: /^crash-test: \d+ iterations, [1-9]\d* violations/ },
  { at: /^##\[error\]/, weak: true },
];
const FAILING_TESTS = /^\s*✖ failing tests:/;
const SUMMARY_END = /^(\[ELIFECYCLE\]|##\[error\]|Error: ERR_PNPM)/;
const CONTEXT_BEFORE = 2;
const CONTEXT_AFTER = 3;
const SUMMARY_LINES = 40;

const isMarker = (line: string): boolean => MARKERS.some((m) => m.at.test(line));

export function logLines(log: string): string[] {
  return log
    .replace(/\s+$/, '')
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^[^\t]*\t[^\t]*\t(?=\d{4}-\d\d-\d\dT)/, '')
        .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '')
        .replace(/\u001b\[[0-9;]*[A-Za-z]/g, ''),
    );
}

function stepLines(lines: string[], step: string | null): string[] {
  let start = step ? lines.indexOf(`##[group]${step}`) : -1;
  if (start === -1) {
    const error = lines.findIndex((l) => l.startsWith('##[error]'));
    start =
      error === -1
        ? 0
        : Math.max(
            0,
            lines.slice(0, error).findLastIndex((l) => l.startsWith('##[group]Run ')),
          );
  }
  const rest = lines.slice(start + 1).findIndex((l) => l.startsWith('##[group]Run ') || l === 'Post job cleanup.');
  return lines.slice(start, rest === -1 ? lines.length : start + 1 + rest);
}

export function failureExcerpt(log: string, step: string | null, bytes = EXCERPT_BYTES): string {
  const lines = stepLines(logLines(log), step);
  const summary = lines.findIndex((l) => FAILING_TESTS.test(l));
  const ranges: [number, number][] = [];
  lines.forEach((line, i) => {
    if (!isMarker(line)) return;
    if (summary !== -1 && i < summary && /^\s*✖/.test(line)) return;
    if (i === summary) {
      const end = lines.slice(i + 1).findIndex((l) => SUMMARY_END.test(l));
      ranges.push([i, Math.min(end === -1 ? lines.length : i + 1 + end, i + SUMMARY_LINES)]);
    } else ranges.push([Math.max(0, i - CONTEXT_BEFORE), Math.min(lines.length, i + 1 + CONTEXT_AFTER)]);
  });
  if (!ranges.length) return logTail(lines.join('\n'), LOG_TAIL_LINES, bytes);
  const out: string[] = [];
  let last = -1;
  for (const [from, to] of ranges) {
    if (to <= last) continue;
    const begin = Math.max(from, last);
    if (out.length && begin > last) out.push('…');
    for (let i = begin; i < to; i++) if (isMarker(lines[i]) || !/^\s*✔/.test(lines[i])) out.push(lines[i]);
    last = to;
  }
  return headBytes(out.join('\n').replace(/^\n+|\s+$/g, ''), bytes);
}

const HEADLINE_CHARS = 160;

export function failureHeadline(excerpt: string): string {
  const lines = excerpt.split('\n').filter((l) => l.trim() && l !== '…');
  const strong = lines.find((l) => MARKERS.some((m) => !m.weak && m.at.test(l)) && !FAILING_TESTS.test(l));
  const line = strong ?? lines.find((l) => l.startsWith('##[error]')) ?? lines.at(-1) ?? '';
  const clean = line
    .replace(/^##\[error\]/, '')
    .replace(/^\s*✖\s*/, '')
    .replace(/\s*\(\d+(?:\.\d+)?m?s\)$/, '')
    .trim();
  return clean.length > HEADLINE_CHARS ? `${clean.slice(0, HEADLINE_CHARS - 1)}…` : clean;
}

export function failureLine(c: Pick<PrCheck, 'name' | 'step' | 'excerpt'>): string {
  const headline = c.excerpt ? failureHeadline(c.excerpt) : '';
  return `${c.name}${c.step ? ` › ${c.step}` : ''}${headline ? `: ${headline}` : ''}`;
}

export const failureRead = (c: PrCheck): boolean => c.excerpt !== undefined || c.excerpt_error !== undefined;

export function withoutFailure(c: PrCheck): PrCheck {
  const { step: _step, step_url: _url, excerpt: _excerpt, excerpt_error: _error, ...check } = c;
  return check;
}

export function carryFailures(
  previous: StoredChecks | null,
  head: string | null,
  checks: PrCheck[],
): { checks: PrCheck[]; unread: PrCheck[] } {
  const before = previous && previous.head === head ? previous.checks : [];
  const kept = checks.map((c) => {
    if (c.state !== 'fail') return c;
    const known = before.find((b) => b.name === c.name && b.url === c.url && b.state === 'fail' && failureRead(b));
    return known ? { ...known, ...withoutFailure(c) } : c;
  });
  return { checks: kept, unread: kept.filter((c) => c.state === 'fail' && !failureRead(c) && actionsRun(c.url)) };
}

/** One failing check as the worker hears it: its name and link, and the failed step and what its log says when there is one. */
export interface FailedCheck {
  name: string;
  url: string | null;
  step?: string | null;
  /** What the failed step's log says (GitHub Actions only, `failureExcerpt`). */
  excerpt?: string;
  /** Why the log could not be read. */
  log_error?: string;
}

export function fixChecksNote(failed: FailedCheck[]): string {
  const parts = [
    'CI checks failed on the PR',
    '',
    `${plural(failed.length, 'check')} failed on GitHub. Find out why, fix it on this branch, and run the tests again. The PR updates when the run finishes.`,
  ];
  for (const c of failed) {
    parts.push('', `### ${c.name}${c.step ? ` › ${c.step}` : ''}${c.url ? ` (${c.url})` : ''}`);
    if (c.excerpt) parts.push(`What failed${c.step ? ` in "${c.step}"` : ''}, from its log:`, '```', c.excerpt, '```');
    else if (c.log_error) parts.push(`The log could not be read: ${c.log_error}`);
    else parts.push('Not a GitHub Actions check: open its link to see why it failed.');
  }
  return parts.join('\n');
}
