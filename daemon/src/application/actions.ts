// The use cases the CLI and the HTTP API share, and the only application module they import.
export {
  installService,
  readLog,
  restartService,
  serviceStatus,
  startService,
  stopService,
  tailDaemonLog,
  uninstallService,
} from '#application/operations/service.ts';
export { type SyncReport, syncNow } from '#application/runs/sync.ts';
export { type VerifyReport, type VerifyStart, startVerify } from '#application/runs/verify.ts';
export { daemonHealth, daemonReport, restartNow } from '#application/operations/doctor.ts';
export type { Check as HealthCheck } from '#domain/operations/index.ts';
export type { ComposedApp } from '#application/ports/app.ts';
export { ActionError, type ActionErrorKind, onOff } from '#application/shared/input.ts';
export { measureBranch, parseFileRef, taskChanges, taskDiff, taskFile, taskTree } from '#application/work/files.ts';
export { type LiveContext, repoForPath } from '#application/operations/digest.ts';
export { liveContext } from '#application/work/live-context.ts';
export { attachPlan, planHtml } from '#application/work/plans.ts';
export { proposeNow } from '#application/proposals/planner.ts';
export { pilotStats } from '#application/insights/stats.ts';
export { closeTaskPr, mergePreview, mergeTask } from '#application/landing/merge/merge.ts';
export { cancelMergeRequest, requestAllMerges, requestMerge, requestMerges } from '#application/landing/merge/merge-requests.ts';
export { setAutoMerge } from '#application/landing/merge/auto-merge.ts';
export { type FixChecksResult, fixChecks } from '#application/landing/pull-request/fix-checks.ts';
export { type OpenTaskPrResult, openTaskPr } from '#application/landing/pull-request/open-pr.ts';
export {
  type DoctorReport,
  type RepoPatch,
  addRepo,
  archiveRepo,
  deleteRepo,
  doctorRepo,
  drainRepo,
  findRepo,
  listRepos,
  repoDeletionPreview,
  repoDetail,
  repoName,
  resumeRepo,
  unarchiveRepo,
  updateRepo,
} from '#application/repos/repos.ts';
export { repoView } from '#application/repos/repo-view.ts';
export {
  addReviewComment,
  deleteReviewComment,
  editReview,
  reopenReviewComment,
  resolveReviewComment,
  startReview,
  submitReview,
  taskReviews,
} from '#application/landing/review/reviews.ts';
export { gracefulRestart } from '#application/operations/restart.ts';
export { ChangeWatcher } from '#application/operations/changes.ts';
export type { Scheduler } from '#application/scheduler/scheduler.ts';
export {
  type DaemonInfo,
  type ReloadFacts,
  type Settings,
  type SettingsPatch,
  appSeen,
  daemonState,
  drain,
  getSettings,
  isPaused,
  maxConcurrent,
  reloadOnChange,
  restartDaemon,
  runningCount,
  sendTestNotification,
  setPaused,
  status,
  updateSettings,
} from '#application/operations/settings.ts';
export { type TaskView, taskDetail, taskViews, withViews } from '#application/work/task-views.ts';
export { addTask, editTask, findTask, listTasks, openPrTasks, removeTaskWorktree, taskRuns } from '#application/work/tasks.ts';
export { approveTask, cancelTask, liftTask, markDone, parkTask, rejectTask, retryTask } from '#application/landing/person-events.ts';
export { installNeeds } from '#application/runs/install-needs.ts';
export { promptWarnings } from '#application/work/prompt-paths.ts';
export { proposalCheck } from '#application/work/proposal-check.ts';
export { BUILDS_ON_STARTED, linkTasks, unlinkTasks } from '#application/work/links.ts';
export type { TaskStatus } from '#domain/work/index.ts';
