// When a PR cannot merge because its branch conflicts with the base. Pure: no I/O.

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
