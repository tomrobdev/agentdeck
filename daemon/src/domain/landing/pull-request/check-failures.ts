// Why a PR's checks failed: the failed step, the lines of its log that say why, and the note that sends them back to the worker.
import { plural } from '../../shared/index.ts';
import type { PrCheck, StoredChecks } from './checks.ts';

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
  const { step: _step, step_url: _url, excerpt: _excerpt, excerpt_error: _error, not_run: _notRun, ...check } = c;
  return check;
}

export function carryFailures(
  previous: StoredChecks | null,
  head: string | null,
  checks: PrCheck[],
): { checks: PrCheck[]; unread: PrCheck[] } {
  const before = previous && previous.head === head ? previous.checks : [];
  const kept = checks.map((c): PrCheck => {
    if (c.state !== 'fail') return c;
    const known = before.find(
      (b) => b.name === c.name && b.url === c.url && ((b.state === 'fail' && failureRead(b)) || b.state === 'not_run'),
    );
    if (known?.state === 'not_run') return { ...withoutFailure(c), state: 'not_run', ...(known.not_run ? { not_run: known.not_run } : {}) };
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
