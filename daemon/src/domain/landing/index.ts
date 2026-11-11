// The landing context's interface: what other contexts and the layers above import.
export {
  hunkAround,
  isReviewRetry,
  latestRequestNote,
  matchAnswers,
  reviewPromptBlock,
  unansweredNote,
  withNote,
} from './review/address.ts';
export type { ReviewPrompt } from './review/address.ts';
export {
  AUTO_MERGE_LABEL,
  DEFAULT_AUTO_MERGE_MAX_LINES,
  DEFAULT_AUTO_MERGE_SKIP,
  autoMergeCheck,
  autoMergeMaxLinesError,
  autoMergeOn,
  autoMergeView,
} from './merge/auto-merge.ts';
export type { AutoMergeFacts, AutoMergeMeasured, AutoMergeState, AutoMergeView } from './merge/auto-merge.ts';
export {
  EXCERPT_BYTES,
  LOG_TAIL_BYTES,
  actionsRun,
  carryFailures,
  failedStep,
  failingChecks,
  failureExcerpt,
  failureHeadline,
  failureLine,
  failureRead,
  fixChecksNote,
  headBytes,
  stepUrl,
  withoutFailure,
} from './pull-request/check-failures.ts';
export type { FailedCheck, JobStep } from './pull-request/check-failures.ts';
export { checksSettled, checksSummary, countOfKept, countWithSteps, nextChecks } from './pull-request/checks.ts';
export type { CheckCounts, CheckState, ChecksSummary, PrCheck, StoredChecks } from './pull-request/checks.ts';
export {
  DEFAULT_CODE_COMMENT_MAX_LINES,
  DEFAULT_CODE_COMMENT_MAX_PERCENT,
  codeCommentMaxLinesError,
  codeCommentMaxPercentError,
  parseAddedLines,
} from './merge/code-comments.ts';
export type { AddedLines } from './merge/code-comments.ts';
export { isConflicting } from './merge/conflict.ts';
export { conflictsWithBase, mergeRequestCheck, mergeRequestView, mergesNow } from './merge/merge-request.ts';
export type { MergeRequestView } from './merge/merge-request.ts';
export { mergeCheck, mergeFailure, mergeFindings, parseBranchPrs, parseJobSteps, parsePrDetails, verdictView } from './merge/merge.ts';
export type {
  AutoMergeCheck,
  BranchPr,
  CreatePr,
  MergeFailure,
  MergeInput,
  MergeReason,
  MergeVerdictView,
  PrDetails,
} from './merge/merge.ts';
export { refreshVerdict } from './pull-request/refresh.ts';
export type { PrPlace } from './pull-request/refresh.ts';
export { buildPrBody, existingPr, finalMessage, isPrExistsError, openPrUrl, prFields, pullRequestOf } from './pull-request/pr.ts';
export { PR_OPEN_RETRIES, prNeedsPerson, prRetry } from './pull-request/pr-retry.ts';
export type { PrOpenFailures, PrRetry } from './pull-request/pr-retry.ts';
export type { PrFields, PrPlan, PrState, PullRequest } from './pull-request/pr.ts';
export { countedReviewRuns, reviewRunCounts } from './review/review-gate.ts';
export type { ReviewFacts } from './review/review-gate.ts';
export {
  BLOCKING_PREFIX,
  COMMENT_SIDES,
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
} from './review/review.ts';
export type {
  CommentAction,
  CommentSide,
  CommentState,
  Review,
  ReviewAuthor,
  ReviewComment,
  ReviewKind,
  ReviewWithComments,
  ReviewedDiff,
} from './review/review.ts';
export { PR_SUMMARY_FORMAT } from './pull-request/summary.ts';
