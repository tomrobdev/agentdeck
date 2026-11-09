// How the dashboard shows a verify run's findings: the order, each verdict's mark, and the card's one line. Pure, so the
// daemon's tests import it (daemon/test/verify-run.test.ts). The findings and their line are the daemon's (domain/runs).
import type { ClaimVerdict, VerifyFinding, VerifyView } from '../../../../daemon/src/api/contract.ts';
import { verifyLine } from '../../../../daemon/src/domain/runs/index.ts';

/** A verdict's mark: its label, its symbol and the status colour it takes. A `false` claim is marked failed. */
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

/** What to read first: false claims, then stale, then partly, then true; in the run's order within each. */
const ORDER: ClaimVerdict[] = ['false', 'stale', 'partly', 'true'];

export const sortFindings = (findings: VerifyFinding[]): VerifyFinding[] =>
  findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => ORDER.indexOf(a.f.verdict) - ORDER.indexOf(b.f.verdict) || a.i - b.i)
    .map(({ f }) => f);

/**
 * The verify run in one line: going, why it ended with no findings, or its findings counted with the commit it read, and
 * a note once the base has moved on from it.
 */
export function verifyHeadline(v: Pick<VerifyView, 'state' | 'findings' | 'commit' | 'stale' | 'reason'>): string {
  if (v.state === 'going') return 'Verify run going: checking the prompt’s claims against the base…';
  if (v.state === 'failed') return `The verify run ended with no findings${v.reason ? `: ${v.reason}` : ''}`;
  const at = v.commit ? ` at ${v.commit.slice(0, 7)}` : '';
  return `${verifyLine(v.findings)}${at}${v.stale ? ' · stale: the base has moved on since' : ''}`;
}
