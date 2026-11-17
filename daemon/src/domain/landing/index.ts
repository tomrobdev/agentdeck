// The landing context's interface: what other contexts and the layers above import.
export {
  hunkAround,
  isReviewRetry,
  latestRequestNote,
  matchAnswers,
  reviewPromptBlock,
  unansweredNote,
  withNote,
} from '#domain/landing/review/address.ts';
export type { ReviewPrompt } from '#domain/landing/review/address.ts';
export {
  AUTO_MERGE_LABEL,
  DEFAULT_AUTO_MERGE_MAX_LINES,
  DEFAULT_AUTO_MERGE_SKIP,
  autoMergeCheck,
  autoMergeMaxLinesError,
  autoMergeOn,
  autoMergeView,
} from '#domain/landing/merge/auto-merge.ts';
export type { AutoMergeFacts, AutoMergeMeasured, AutoMergeState, AutoMergeView } from '#domain/landing/merge/auto-merge.ts';
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
} from '#domain/landing/pull-request/check-failures.ts';
export type { FailedCheck, JobStep } from '#domain/landing/pull-request/check-failures.ts';
export {
  checksSettled,
  checksSummary,
  countOfKept,
  countWithSteps,
  nextChecks,
  withCheckList,
} from '#domain/landing/pull-request/checks.ts';
export { asNotRun, notStartedMessage } from '#domain/landing/pull-request/ci-not-run.ts';
export type { JobStart } from '#domain/landing/pull-request/ci-not-run.ts';
export type { CheckCounts, CheckState, ChecksSummary, PrCheck, StoredChecks } from '#domain/landing/pull-request/checks.ts';
export {
  DEFAULT_CODE_COMMENT_MAX_LINES,
  DEFAULT_CODE_COMMENT_MAX_PERCENT,
  codeCommentLimitOn,
  codeCommentLimitText,
  codeCommentMaxLinesError,
  codeCommentMaxPercentError,
  codeCommentsOver,
  codeCommentsText,
  countCodeComments,
  parseAddedLines,
} from '#domain/landing/merge/code-comments.ts';
export type { AddedLines, CodeCommentCount, CodeCommentLimits } from '#domain/landing/merge/code-comments.ts';
export { isConflicting } from '#domain/landing/merge/conflict.ts';
export {
  conflictsWithBase,
  mergeRequestCheck,
  mergeRequestStateOf,
  mergeRequestStatesFor,
  mergeRequestView,
  mergesNow,
  nextMergeRequestState,
} from '#domain/landing/merge/merge-request.ts';
export type { MergeRequestMove, MergeRequestView } from '#domain/landing/merge/merge-request.ts';
export { nextPrState, prFrom, prStatesFor, seenMove } from '#domain/landing/pull-request/pr-moves.ts';
export type { PrFrom, PrMove } from '#domain/landing/pull-request/pr-moves.ts';
export {
  mergeCheck,
  mergeFailure,
  mergeFindings,
  mergeSyncsFirst,
  parseAnnotations,
  parseBranchPrs,
  parseJobStart,
  parseJobSteps,
  parsePrDetails,
  syncingFirstLine,
  verdictView,
} from '#domain/landing/merge/merge.ts';
export type {
  AutoMergeCheck,
  BranchPr,
  CreatePr,
  MergeFailure,
  MergeInput,
  MergeReason,
  MergeVerdictView,
  PrDetails,
} from '#domain/landing/merge/merge.ts';
export { refreshVerdict } from '#domain/landing/pull-request/refresh.ts';
export type { PrPlace } from '#domain/landing/pull-request/refresh.ts';
export {
  buildPrBody,
  existingPr,
  finalMessage,
  isPrExistsError,
  openPrUrl,
  prFields,
  pullRequestOf,
} from '#domain/landing/pull-request/pr.ts';
export { PR_OPEN_RETRIES, prNeedsPerson, prRetry } from '#domain/landing/pull-request/pr-retry.ts';
export type { PrOpenFailures, PrRetry } from '#domain/landing/pull-request/pr-retry.ts';
export type { PrFields, PrPlan, PrState, PullRequest } from '#domain/landing/pull-request/pr.ts';
export { countedReviewRuns, reviewRunCounts } from '#domain/landing/review/review-gate.ts';
export type { ReviewFacts } from '#domain/landing/review/review-gate.ts';
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
} from '#domain/landing/review/review.ts';
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
} from '#domain/landing/review/review.ts';
export { PR_SUMMARY_FORMAT } from '#domain/landing/pull-request/summary.ts';
