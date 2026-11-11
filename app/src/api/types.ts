// The daemon's API types come from its contract (daemon/src/api/contract/<context>.ts), which the daemon checks against its use cases.
import type { MergeMethod } from '#daemon/domain/repos/index.ts';

export type { PrRetry, PrState } from '#daemon/domain/landing/index.ts';
export type { ClaimVerdict, VerifyFinding, VerifyView } from '#daemon/domain/runs/index.ts';
export type { FileRef, LinkKind, TaskStatus } from '#daemon/domain/work/index.ts';
export type { MergeMethod, PrMode } from '#daemon/domain/repos/index.ts';
export type { NotifyKind } from '#daemon/domain/operations/index.ts';
export type {
  DoctorCheck,
  DoctorReport,
  NewRepo,
  PlannerRun,
  ProposalResult,
  Repo,
  RepoDeleted,
  RepoDeletion,
  RepoDetail,
  RepoPatch,
} from '#daemon/api/contract/repos.ts';
export type {
  CancelResult,
  MarkDoneRequest,
  Needs,
  NewLink,
  NewTask,
  PlanHtml,
  PlanStep,
  QueueWait,
  RetryRequest,
  StartWait,
  Task,
  TaskDetail,
  TaskSaved,
  TaskEventRow,
  TaskLink,
  TaskPatch,
  TaskPlan,
  TaskSummary,
} from '#daemon/api/contract/work.ts';
export type { LiveView, Run, RunSummary, SyncResult, SyncView, VerifyResult } from '#daemon/api/contract/runs.ts';
export type {
  AutoMergeCheck,
  AutoMergeRequest,
  AutoMergeResult,
  AutoMergeView,
  CancelMergeRequestResult,
  ChecksSummary,
  FixChecksResult,
  OpenPrResult,
  PrCheck,
  MergePreview,
  MergeRequest,
  MergeRequestView,
  MergeResult,
  NewReviewComment,
  RequestMergeRequest,
  RequestMergeResult,
  RequestMergesRequest,
  RequestMergesResult,
  Review,
  ReviewComment,
  ReviewPatch,
  SubmitReview,
} from '#daemon/api/contract/landing.ts';
export type {
  Changes,
  ChangedFile,
  Commit,
  SincePoint,
  FileContent,
  FilePatch,
  LogEntry,
  ProposalCheck,
  TreeEntry,
  TreeListing,
} from '#daemon/api/contract/files.ts';
export type {
  Budget,
  Decision,
  DaemonHealth,
  DaemonState,
  NotificationRow,
  RestartNowResult,
  RestartResult,
  RunningTask,
  ServiceStatus,
  Settings,
  SettingsPatch,
  Status,
  TestNotifyResult,
  UsageWindow,
} from '#daemon/api/contract/operations.ts';
export type { Stats } from '#daemon/api/contract/insights.ts';

export const MERGE_METHODS: { key: MergeMethod; label: string; hint: string }[] = [
  { key: 'squash', label: 'Squash and merge', hint: 'One commit on the base branch' },
  { key: 'merge', label: 'Create a merge commit', hint: 'Keeps every commit' },
  { key: 'rebase', label: 'Rebase and merge', hint: 'Replays every commit on the base branch' },
];

export { PATCH_LIMIT, TEXT_LIMIT } from '#daemon/domain/work/index.ts';
