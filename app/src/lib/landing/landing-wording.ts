// How the dashboard words a pull request's path to merging: auto-merge, a merge request, opening the PR and a sync.
import type { AutoMergeCheck, MergeRequestView, PrRetry, SyncResult } from '../../api/types.ts';
import { plural } from '../../../../daemon/src/domain/shared/index.ts';
import { parseTime } from '../shared/time.ts';

/** Whether the daemon will merge a PR on its own, in a line. */
export function autoMergeLine(c: AutoMergeCheck): string {
  if (c.verdict === 'merge') return 'on; merges on the next PR refresh';
  return `${c.verdict === 'wait' ? 'on; waiting: ' : 'needs you: '}${c.reasons.join('; ')}`;
}

/** A task's merge request on its row: "Merging when ready · 2 checks running", or "Merging…". */
export function describeMergeRequest(r: MergeRequestView): string {
  if (r.state === 'merging') return 'Merging…';
  return ['Merging when ready', ...r.reasons].join(' · ');
}

/** What a sync of a task's branch came to, in a sentence. Where the push went is the caller's to add. */
export function syncLine(r: Pick<SyncResult, 'outcome' | 'files' | 'reason'>): string {
  switch (r.outcome) {
    case 'resolved':
      return `Resolved conflicts in ${plural(r.files.length, 'file')}.`;
    case 'clean':
      return 'Synced with the base branch.';
    case 'up_to_date':
      return 'The branch is already synced with the base branch.';
    case 'blocked':
      return `Blocked: ${r.reason ?? 'the conflicts could not be settled'}`;
    default:
      return r.reason ?? r.outcome;
  }
}

/** Why a done task's PR is not open yet, for the Open PR button's tooltip: its failures, and whether the PR refresh tries again. */
export function describePrRetry(r: PrRetry): string {
  const tries = `${r.failures} ${r.failures === 1 ? 'try' : 'tries'} to open the PR failed: ${r.error}`;
  if (r.state === 'person') return `${tries}. The PR refresh stopped trying; open it by hand.`;
  const at = r.next_at ? ` at ${new Date(parseTime(r.next_at)).toLocaleTimeString()}` : '';
  return `${tries}. The PR refresh tries again${at}.`;
}
