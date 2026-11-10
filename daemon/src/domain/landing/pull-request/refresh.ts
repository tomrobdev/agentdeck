// What the PR refresh makes of one open PR of a done task: the check that stands, where the PR goes, and whether a person's merge request is dropped.
import { type AutoMergeFacts, autoMergeCheck } from '../merge/auto-merge.ts';
import { isConflicting, isMergeabilityUnknown } from '../merge/conflict.ts';
import { mergeRequestCheck, mergeRequestPolls } from '../merge/merge-request.ts';
import { type AutoMergeCheck, type MergeInput, type PrDetails, reasonTexts } from '../merge/merge.ts';

/** Where a PR goes in a refresh's findings: it conflicts with the base, GitHub has not worked out its mergeability, it is ready to merge, or none of these. */
export type PrPlace = 'conflicting' | 'unknown' | 'mergeable' | null;

function placeOf(pr: Pick<PrDetails, 'state' | 'mergeable' | 'merge_state'>, verdict: AutoMergeCheck['verdict'] | null): PrPlace {
  if (pr.state !== 'open') return null;
  if (isConflicting(pr)) return 'conflicting';
  if (isMergeabilityUnknown(pr)) return 'unknown';
  return verdict === 'merge' ? 'mergeable' : null;
}

/** What the refresh read about one open PR of a done task. */
export interface RefreshRead {
  /** The merge input, its PR as GitHub said it now (with the checks the refresh kept). */
  input: MergeInput;
  /** A person asked for the merge: their merge request's check stands in for auto-merge's. */
  requested: boolean;
  /** What auto-merge's check reads beside the input; null when auto-merge is off for the task, or a person asked. */
  auto: AutoMergeFacts | null;
}

/** What the refresh does about one open PR. */
export interface RefreshVerdict {
  /** The auto-merge check to keep on the task: null when auto-merge is off, or a person's merge request stands in for it. */
  auto_merge_check: AutoMergeCheck | null;
  /** The merge request's check to keep; null when there is no request, or it is dropped. */
  request_check: AutoMergeCheck | null;
  /** Why the merge request is dropped (its check needs a person), told as it is; null when it stays or there is none. */
  drop: string | null;
  /** Where the PR goes in the refresh's findings; a dropped request's PR goes nowhere. */
  place: PrPlace;
  /** A merge request worth reading again soon: its checks are running, or GitHub is working out mergeability. */
  polling: boolean;
}

export function refreshVerdict({ input, requested, auto }: RefreshRead): RefreshVerdict {
  const { pr } = input;
  if (requested) {
    const check = mergeRequestCheck(input);
    if (check.verdict === 'never')
      return { auto_merge_check: null, request_check: null, drop: reasonTexts(check.reasons).join('; '), place: null, polling: false };
    return {
      auto_merge_check: null,
      request_check: check,
      drop: null,
      place: placeOf(pr, check.verdict),
      polling: mergeRequestPolls(check, pr),
    };
  }
  const check = auto ? autoMergeCheck({ ...input, ...auto }) : null;
  return { auto_merge_check: check, request_check: null, drop: null, place: placeOf(pr, check?.verdict ?? null), polling: false };
}
