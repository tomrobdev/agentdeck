// How a sync (merging the base branch into a task's branch) is worded, and how a resolve run's end settles it. Pure: no I/O.
import { type RunClass, parseStatus } from '../run/run.ts';
import { plural } from '../text.ts';

/** How a sync that changed the branch went. */
type SyncKind = 'clean' | 'resolved';

/** What a sync of a task's branch came to. A merge that did not stick is already undone. */
export type SyncResult =
  | { kind: 'up_to_date' }
  | { kind: 'clean' }
  | { kind: 'resolved'; files: string[] }
  /** Conflicts, and no resolve run was allowed. */
  | { kind: 'needs_resolution'; files: string[] }
  /** The resolve run could not fix the conflicts, or the tests failed on the result. */
  | { kind: 'failed'; files: string[]; reason: string }
  | { kind: 'rate_limited'; reason: string }
  | { kind: 'cancelled' }
  /** Git itself failed (no base ref, a lock, …). */
  | { kind: 'error'; reason: string };

const fileCount = (n: number) => plural(n, 'file');

/** The task timeline's line for a sync that changed the branch: "Synced with main: clean". */
export function syncSummary(base: string, kind: SyncKind, conflictFiles: string[]): string {
  return kind === 'clean' ? `Synced with ${base}: clean` : `Resolved conflicts in ${fileCount(conflictFiles.length)}`;
}

const LISTED_FILES = 5;

/** The stop reason when a conflict could not be settled: names the files. */
export function conflictReason(base: string, conflictFiles: string[], why?: string): string {
  const shown = conflictFiles.slice(0, LISTED_FILES).join(', ');
  const more = conflictFiles.length > LISTED_FILES ? ` and ${conflictFiles.length - LISTED_FILES} more` : '';
  const list = conflictFiles.length
    ? `conflicts with ${base} in ${fileCount(conflictFiles.length)}: ${shown}${more}`
    : `could not sync with ${base}`;
  return why ? `${list} (${why})` : list;
}

/** What a resolve run's end settles on its own, or `check`: the agent said it was done, so the merge and the tests decide. */
export type ResolveOutcome =
  { outcome: 'cancelled' } | { outcome: 'rate_limited' | 'failed' | 'blocked'; reason: string } | { outcome: 'check' };

/** A resolve run's outcome from how claude ended, reading the final message's STATUS once. */
export function resolveOutcome(end: RunClass): ResolveOutcome {
  if (end.kind === 'cancelled') return { outcome: 'cancelled' };
  if (end.kind === 'rate_limited') return { outcome: 'rate_limited', reason: end.reason };
  if (end.kind === 'failed') return { outcome: 'failed', reason: end.reason };
  const status = parseStatus(end.result.result);
  if (status.blocked) return { outcome: 'blocked', reason: status.reason ?? 'the agent could not resolve the conflicts' };
  return { outcome: 'check' };
}

/** The sync's result once its resolve run has ended as `outcome` (`done`: the conflicts are resolved). */
export function syncResultOf(
  outcome: 'done' | 'cancelled' | 'rate_limited' | 'failed' | 'blocked',
  conflictFiles: string[],
  reason: string,
): SyncResult {
  switch (outcome) {
    case 'done':
      return { kind: 'resolved', files: conflictFiles };
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'rate_limited':
      return { kind: 'rate_limited', reason };
    default:
      return { kind: 'failed', files: conflictFiles, reason };
  }
}

/** Whether a stop reason is a conflict's (`conflictReason`): a sync that could not be settled. */
export function isConflictReason(reason: string | null | undefined): boolean {
  return /^(conflicts with \S+ in \d+ files?: |could not sync with )/.test(reason ?? '');
}
