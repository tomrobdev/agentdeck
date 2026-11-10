// When a PR cannot merge because its branch conflicts with the base.

/** What GitHub says about a PR's mergeability. */
export interface PrMergeability {
  /** GitHub's `mergeable`: MERGEABLE, CONFLICTING or UNKNOWN (it is computed lazily). */
  mergeable: string;
  /** GitHub's `mergeStateStatus`: CLEAN, BEHIND, DIRTY, … */
  merge_state: string;
}

export const isConflicting = (pr: PrMergeability): boolean => pr.mergeable === 'CONFLICTING' || pr.merge_state === 'DIRTY';

export const isMergeabilityUnknown = (pr: PrMergeability): boolean => pr.mergeable === 'UNKNOWN' && pr.merge_state !== 'DIRTY';
