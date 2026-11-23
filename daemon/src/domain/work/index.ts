// The work context's interface: what other contexts and the layers above import.
export { branchName } from '#domain/work/task/branch.ts';
export { checkoutOf } from '#domain/work/task/checkout.ts';
export type { Checkout } from '#domain/work/task/checkout.ts';
export {
  continuedSinceRetry,
  isAutoMergeReason,
  latestRetryAt,
  latestReviewNote,
  mergeReason,
  prEventReason,
  prEventsOf,
  prMoveOf,
  prRetryFor,
} from '#domain/work/lifecycle/history.ts';
export type { PendingFollowUp, PrEvent, TaskEventRow, TaskEventType } from '#domain/work/lifecycle/history.ts';
export { parseTaskIds } from '#domain/work/task/ids.ts';
export {
  autoMergeCheckChanges,
  autoMergeSettingChanges,
  mergedPrChanges,
  modelChanges,
  maxTurnsChanges,
  mergeRequestChanges,
  mergeRequestCheckChanges,
  noMergeRequestChanges,
  planBranchTargetChanges,
  prChanges,
  prChecksChanges,
  prChecksOpenedChanges,
  questionChanges,
} from '#domain/work/lifecycle/task-writes.ts';
export type { TaskChanges } from '#domain/work/lifecycle/task-writes.ts';
export { followUpsOf, followUpsOfRow } from '#domain/work/lifecycle/follow-ups.ts';
export type { FollowUp } from '#domain/work/lifecycle/follow-ups.ts';
export {
  MAX_RESTARTS,
  NOT_STARTED_STATUSES,
  TASK_STATUSES,
  fromStatuses,
  personEvents,
  transition,
} from '#domain/work/lifecycle/lifecycle.ts';
export type { DomainEvent, PersonEvent, TaskEvent, TaskStatus } from '#domain/work/lifecycle/lifecycle.ts';
export {
  buildsOnError,
  buildsOnRepoError,
  dependentViews,
  linkError,
  linkState,
  linkViews,
  prModeOffError,
  releasedBy,
  startState,
  stuckOn,
  unblocksOf,
  unlandedAfter,
} from '#domain/work/links/link.ts';
export type { Dependent, Link, LinkIndex, LinkKind, LinkTarget, LinkView, LinkedTask, StartState } from '#domain/work/links/link.ts';
export {
  INSTALL_NOTE,
  LOCKFILES,
  canInstallWith,
  depsRequest,
  depsRequestError,
  installArgs,
  isNeeds,
  parseNeeds,
} from '#domain/work/task/needs.ts';
export type { Needs, NeedsKind, UnblockQuestion } from '#domain/work/task/needs.ts';
export { hasPlanLink, otherPlanOwner, planOwnerOf } from '#domain/work/plans/plan-link.ts';
export type { PlanFollower, PlanLink } from '#domain/work/plans/plan-link.ts';
export {
  PLAN_FILE,
  PLAN_GIVEN_FILE,
  PLAN_LIMIT,
  isOwnPlanName,
  linkedSteps,
  missingFollowedSteps,
  parsePlan,
  parsePlanWithText,
  planAfterRun,
  planFileName,
  planProgress,
  toPlan,
  unfinishedSteps,
  unfinishedSummary,
} from '#domain/work/plans/plan.ts';
export type { OwnPlan, ParsedPlan, PlanSource, PlanStepStatus, TaskPlan } from '#domain/work/plans/plan.ts';
export { matchPath, pathsNamedIn } from '#domain/work/plans/prompt-paths.ts';
export {
  DEFAULT_PLAN_BRANCH_MAX_DAYS,
  DEFAULT_PLAN_BRANCH_MAX_LINES,
  DEFAULT_PLAN_BRANCH_SYNC_MINUTES,
  abandonRunningError,
  isLivePlanBranch,
  mayResolvePlanBranch,
  LIVE_PLAN_BRANCH_STATUSES,
  needsCut,
  nextPlanBranchStatus,
  planBranchConflict,
  planBranchMaxDaysError,
  planBranchMaxLinesError,
  planBranchMoveError,
  planBranchName,
  planBranchOpenError,
  planBranchOverLimitEntry,
  planBranchStatusesFor,
  planBranchSyncDue,
  planBranchSyncMinutesError,
  planBranchSyncMove,
  planBranchTarget,
  planBranchWait,
  planBranchWaitText,
  reposToOpen,
  tasksBackToBase,
  tasksToTarget,
} from '#domain/work/plans/plan-branch.ts';
export type {
  LandingPolicy,
  PlanBranch,
  PlanBranchConflict,
  PlanBranchMove,
  PlanBranchStatus,
  PlanBranchSyncOutcome,
  PlanBranchTask,
} from '#domain/work/plans/plan-branch.ts';
export {
  DEFAULT_LANDING_POLICY,
  LANDING_ANSWERS,
  LANDING_POLICIES,
  afterLandingMerge,
  afterPlanPrState,
  isLandingAnswer,
  isLandingPolicy,
  landingAnswerMove,
  landingOrder,
  landingOrderError,
  landingQuestion,
  nextLandingStep,
  partlyLandedLine,
  revertFrom,
} from '#domain/work/plans/landing-saga.ts';
export type { LandingAnswer, LandingBranch, LandingChange, LandingQuestion } from '#domain/work/plans/landing-saga.ts';
export {
  nextPlanReviewState,
  planReviewDue,
  planReviewMoveOf,
  planReviewReasons,
  planReviewStatesFor,
} from '#domain/work/plans/plan-review.ts';
export type { PlanReviewMove, PlanReviewState } from '#domain/work/plans/plan-review.ts';
export {
  type PlanThrough,
  isWaitingToLand,
  landsThrough,
  planLandingOf,
  planLandingText,
  planPrBody,
  readyToLand,
  reviewVerdictOf,
} from '#domain/work/plans/plan-landing.ts';
export type { PlanLanding, PunchLine } from '#domain/work/plans/plan-landing.ts';
export {
  BASE_LOG_FORMAT,
  CHECKED_STATUSES,
  emptyProposalCheck,
  mayOverlap,
  overlaps,
  parseBaseLog,
  proposalCheckLine,
  staleness,
} from '#domain/work/task/proposal-check.ts';
export type { BaseCommit, Overlap, ProposalCheck, Staleness } from '#domain/work/task/proposal-check.ts';
export { describeEvent } from '#domain/work/read/event-text.ts';
export type { PersonEventText } from '#domain/work/read/event-text.ts';
export {
  fileRefRun,
  isFileRef,
  verifyFileRef,
  LOG_FORMAT,
  PATCH_LIMIT,
  TEXT_LIMIT,
  capText,
  checkPath,
  isBinary,
  mergeChanges,
  parseLog,
  parseLsTree,
  treeEntries,
} from '#domain/work/read/files.ts';
export type {
  ChangeStatus,
  ChangedFile,
  Changes,
  Commit,
  FileContent,
  FilePatch,
  FileRef,
  Tree,
  TreeEntry,
} from '#domain/work/read/files.ts';
export { sincePoints } from '#domain/work/read/since.ts';
export type { SinceKind } from '#domain/work/read/since.ts';
export { DECISION_STATES, FILTER_STATES, SORT_OPTIONS, filterTasks, listable } from '#domain/work/read/listing.ts';
export {
  archivedRepoError,
  maxAttemptsError,
  MOST_TURNS,
  maxTurnsError,
  modelError,
  priorityError,
  stepsNeedPlanError,
} from '#domain/work/task/rules.ts';
export {
  STATUS_GROUPS,
  canOpenPr,
  canStartMerge,
  hasOpenPr,
  isMerged,
  isReview,
  isStuck,
  isWaiting,
  stageOf,
  statusGroup,
} from '#domain/work/task/stage.ts';
export type { StatusGroup } from '#domain/work/task/stage.ts';
export { footprint, overlapWith } from '#domain/work/task/footprint.ts';
export type { Footprinted } from '#domain/work/task/footprint.ts';
export { describeWait, startDecision, startWait, waitingFor } from '#domain/work/task/start.ts';
export type { QueueState, QueueWait, StartWait, Waiting } from '#domain/work/task/start.ts';
export {
  DEFAULT_MODEL,
  EDITABLE_STATUSES,
  MODELS,
  OPEN_STATUSES,
  PLAN_ATTACHABLE_STATUSES,
  RUNNING_STATUSES,
  WORKTREE_REMOVABLE_STATUSES,
  attemptsLeft,
  defaultTitle,
  isBlocked,
  leftoversMessage,
  modelSourceText,
  newTaskModel,
  stateFields,
  stopReasonOf,
} from '#domain/work/task/task.ts';
export { buildsOnTargetError, missingTargetError, placeAt, targetChangeError, targetOf } from '#domain/work/task/target.ts';
export type { Place, TargetEnd } from '#domain/work/task/target.ts';
export { PROMPT_SECTIONS, promptBrief, promptGoal, promptSection, shapePrompt } from '#domain/work/task/prompt.ts';
export type {
  BlockedState,
  BlockedTask,
  CancelledState,
  DoneState,
  FailedState,
  ModelSource,
  ParkedState,
  StateFields,
  Task,
  TaskSource,
  TaskState,
  TaskSummary,
} from '#domain/work/task/task.ts';
export { ISSUE_LABELS, issueRepoAddError, issueTextEditError, signed } from '#domain/work/issues/issue.ts';
export { ISSUE_FIELDS, labelledBy, parseIssue, parseIssueComments, parseIssues, parseLabelNames } from '#domain/work/issues/parse.ts';
export type { Issue, IssueComment, IssueReport, TaskIssue } from '#domain/work/issues/issue.ts';
export {
  dueIssueWrite,
  isAllowed,
  isFinalReport,
  issueIntake,
  issueMove,
  issueNote,
  labelRefusal,
  proposalIntake,
} from '#domain/work/issues/sync.ts';
export { duePlanIssueWrite, planIntake, planOwnerParkReason } from '#domain/work/issues/plan-issue.ts';
