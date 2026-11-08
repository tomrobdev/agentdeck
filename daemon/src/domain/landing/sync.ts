// How a sync (merging the base branch into a task's branch) is worded, and what it comes to. How a resolve run's end settles
// it is the Runs context's (domain/runs/resolve.ts). Pure: no I/O.
import { plural } from '../shared/index.ts';

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
