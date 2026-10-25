// How a sync (bringing the base branch into a task's branch) is worded. Pure: no I/O.

/** How much of the base a sync brought into the branch. */
export type SyncKind = 'clean' | 'resolved';

const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

/** The task timeline's line for a sync that changed the branch: "Brought in main: clean". */
export function syncSummary(base: string, kind: SyncKind, conflictFiles: string[]): string {
  return kind === 'clean' ? `Brought in ${base}: clean` : `Resolved conflicts in ${files(conflictFiles.length)}`;
}

const LISTED_FILES = 5;

/** The stop reason when a conflict could not be settled: names the files. */
export function conflictReason(base: string, conflictFiles: string[], why?: string): string {
  const shown = conflictFiles.slice(0, LISTED_FILES).join(', ');
  const more = conflictFiles.length > LISTED_FILES ? ` and ${conflictFiles.length - LISTED_FILES} more` : '';
  const list = conflictFiles.length
    ? `conflicts with ${base} in ${files(conflictFiles.length)}: ${shown}${more}`
    : `could not bring in ${base}`;
  return why ? `${list} (${why})` : list;
}
