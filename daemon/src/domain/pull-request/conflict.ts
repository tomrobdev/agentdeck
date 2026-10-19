// When a task branch conflicts with its base, and how that is worded. Pure: no I/O.

/** What GitHub says about a PR's mergeability. */
export interface PrMergeability {
  /** GitHub's `mergeable`: MERGEABLE, CONFLICTING or UNKNOWN (it is computed lazily). */
  mergeable: string;
  /** GitHub's `mergeStateStatus`: CLEAN, BEHIND, DIRTY, … */
  merge_state: string;
}

/** The PR cannot merge because its branch conflicts with the base. */
export const isConflicting = (pr: PrMergeability): boolean => pr.mergeable === 'CONFLICTING' || pr.merge_state === 'DIRTY';

/** GitHub has not worked out yet whether the PR conflicts; ask again shortly. */
export const isMergeabilityUnknown = (pr: PrMergeability): boolean => pr.mergeable === 'UNKNOWN' && pr.merge_state !== 'DIRTY';

/** How much of the base a sync brought into the branch. */
export type SyncKind = 'clean' | 'resolved';

const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

/** The task timeline's line for a sync that changed the branch: "Brought in main: clean". */
export function syncSummary(base: string, kind: SyncKind, conflictFiles: string[]): string {
  return kind === 'clean' ? `Brought in ${base}: clean` : `Resolved conflicts in ${files(conflictFiles.length)}`;
}

const LISTED_FILES = 5;

/** The blocked reason when a conflict could not be resolved: names the files. */
export function conflictReason(base: string, conflictFiles: string[], why?: string): string {
  const shown = conflictFiles.slice(0, LISTED_FILES).join(', ');
  const more = conflictFiles.length > LISTED_FILES ? ` and ${conflictFiles.length - LISTED_FILES} more` : '';
  const list = conflictFiles.length
    ? `conflicts with ${base} in ${files(conflictFiles.length)}: ${shown}${more}`
    : `could not bring in ${base}`;
  return why ? `${list} (${why})` : list;
}
