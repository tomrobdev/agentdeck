import type { ClaimVerdict, VerifyFinding, VerifyView } from '../../../../daemon/src/domain/runs/index.ts';
import { verifyLine } from '../../../../daemon/src/domain/runs/index.ts';

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

export function verifyHeadline(v: Pick<VerifyView, 'state' | 'findings' | 'commit' | 'stale' | 'reason'>): string {
  if (v.state === 'going') return 'Verify run going: checking the prompt’s claims against the base…';
  if (v.state === 'failed') return `The verify run ended with no findings${v.reason ? `: ${v.reason}` : ''}`;
  const at = v.commit ? ` at ${v.commit.slice(0, 7)}` : '';
  return `${verifyLine(v.findings)}${at}${v.stale ? ' · stale: the base has moved on since' : ''}`;
}
