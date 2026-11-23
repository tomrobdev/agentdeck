import type { ClaimVerdict, VerifyFinding, VerifyView } from '#daemon/domain/runs/index.ts';
import { verifyLine } from '#daemon/domain/runs/index.ts';

export interface VerdictMark {
  label: string;
  icon: string;
  tone: 'done' | 'failed' | 'blocked';
}

export const VERDICT_MARKS: Record<ClaimVerdict, VerdictMark> = {
  true: { label: 'true', icon: '✓', tone: 'done' },
  false: { label: 'false', icon: '✕', tone: 'failed' },
  stale: { label: 'stale', icon: '↻', tone: 'blocked' },
  partly: { label: 'partly', icon: '◐', tone: 'blocked' },
};

const ORDER: ClaimVerdict[] = ['false', 'stale', 'partly', 'true'];

export const sortFindings = (findings: VerifyFinding[]): VerifyFinding[] =>
  findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => ORDER.indexOf(a.f.verdict) - ORDER.indexOf(b.f.verdict) || a.i - b.i)
    .map(({ f }) => f);

export const verifyAt = (v: Pick<VerifyView, 'commit' | 'stale'>): string =>
  [v.commit && `at ${v.commit.slice(0, 7)}`, v.stale && 'stale: the base has moved on since'].filter(Boolean).join(' · ');

export function verifyHeadline(v: Pick<VerifyView, 'state' | 'findings' | 'commit' | 'stale' | 'reason'>): string {
  if (v.state === 'going') return 'Verify run going: checking the prompt’s claims against the base…';
  if (v.state === 'failed') return `The verify run ended with no findings${v.reason ? `: ${v.reason}` : ''}`;
  return [verifyLine(v.findings), verifyAt(v)].filter(Boolean).join(' ');
}

export const hasFindingsToFix = (v: Pick<VerifyView, 'state' | 'findings'>): boolean =>
  v.state === 'done' && v.findings.some((f) => f.verdict !== 'true');

const CONTEXT_LINES = 4;

export function snippetOf(
  text: string,
  range: { from: number; to: number },
  context = CONTEXT_LINES,
): { first: number; text: string } | null {
  const lines = text.split('\n');
  if (range.from > lines.length) return null;
  const first = Math.max(1, range.from - context);
  return { first, text: lines.slice(first - 1, range.to + context).join('\n') };
}

export const verdictCounts = (findings: Pick<VerifyFinding, 'verdict'>[]): { verdict: ClaimVerdict; count: number }[] =>
  ORDER.map((verdict) => ({ verdict, count: findings.filter((f) => f.verdict === verdict).length })).filter((c) => c.count > 0);

export function verdictsShownFirst(findings: Pick<VerifyFinding, 'verdict'>[]): ClaimVerdict[] {
  const present = verdictCounts(findings).map((c) => c.verdict);
  const problems = present.filter((v) => v !== 'true');
  return problems.length ? problems : present;
}

export interface FindingFile {
  folder: string;
  name: string;
  range: { from: number; to: number } | null;
  query: Record<string, string>;
}

export function findingFile(f: Pick<VerifyFinding, 'path' | 'line' | 'end_line'>): FindingFile | null {
  if (!f.path) return null;
  const slash = f.path.lastIndexOf('/') + 1;
  const range = f.line === null ? null : { from: f.line, to: f.end_line ?? f.line };
  const lines = !range ? '' : range.from === range.to ? `${range.from}` : `${range.from}-${range.to}`;
  return {
    folder: f.path.slice(0, slash),
    name: `${f.path.slice(slash)}${lines && `:${lines}`}`,
    range,
    query: { path: f.path, ...(lines && { L: lines }) },
  };
}
