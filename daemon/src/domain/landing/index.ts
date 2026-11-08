// The landing context's interface: what other contexts and the layers above import.
export { hunkAround, isReviewRetry, latestRequestNote, matchAnswers, reviewPromptBlock, unansweredNote, withNote } from './address.ts';
export type { ReviewPrompt } from './address.ts';
export {
  AUTO_MERGE_LABEL,
  DEFAULT_AUTO_MERGE_MAX_LINES,
  DEFAULT_AUTO_MERGE_SKIP,
  autoMergeCheck,
  autoMergeMaxLinesError,
  autoMergeOn,
  autoMergeView,
} from './auto-merge.ts';
export type { AutoMergeCheck, AutoMergeMeasured, AutoMergeState, AutoMergeView } from './auto-merge.ts';
export { LOG_TAIL_BYTES, actionsRun, checksSettled, checksSummary, failingChecks, fixChecksNote, logTail, nextChecks } from './checks.ts';
export type { CheckCounts, CheckState, ChecksSummary, FailedCheck, PrCheck, StoredChecks } from './checks.ts';
export { isConflicting, isMergeabilityUnknown } from './conflict.ts';
export { conflictsWithBase, mergeRequestCheck, mergeRequestPolls, mergeRequestView, mergesNow } from './merge-request.ts';
export type { MergeRequestView } from './merge-request.ts';
export { mergeCheck, mergeFindings, parsePrDetails } from './merge.ts';
export type { CreatePr, PrDetails } from './merge.ts';
export { buildPrBody, finalMessage, openPrUrl, prFields, pullRequestOf } from './pr.ts';
export type { PrFields, PrPlan, PrState, PullRequest } from './pr.ts';
export {
  commentActionError,
  commentLineError,
  commentLocation,
  commentSideError,
  commentStatesFor,
  commentsToAddress,
  draftError,
  emptyReviewError,
  nextCommentState,
  reviewKindError,
  reviewReason,
} from './review.ts';
export type { CommentAction, CommentSide, CommentState, Review, ReviewComment, ReviewKind, ReviewWithComments } from './review.ts';
export { PR_SUMMARY_FORMAT } from './summary.ts';
export { conflictReason, isConflictReason, syncResultOf, syncSummary } from './sync.ts';
export type { SyncResult } from './sync.ts';
