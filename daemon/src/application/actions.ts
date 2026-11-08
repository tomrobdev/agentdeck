// The use cases the CLI and the HTTP API share, and the only application module they import. They throw ActionError on bad input.
// Everything is named: nothing here is `export *`, and nothing comes from adapters/ or db/.
// The launchd service the daemon runs under, for the CLI's daemon commands, and a run's log.
export {
  installService,
  readLog,
  restartService,
  serviceStatus,
  startService,
  stopService,
  tailDaemonLog,
  uninstallService,
} from './operations/service.ts';
export { type SyncReport, syncNow } from './runs/sync.ts';
export { daemonHealth, daemonReport, restartNow } from './operations/doctor.ts';
export type { Check as HealthCheck } from '../domain/operations/index.ts';
export type { ComposedApp } from './ports/app.ts';
export { ActionError, onOff } from './shared/input.ts';
export { measureBranch, parseFileRef, taskChanges, taskDiff, taskFile, taskTree } from './work/files.ts';
export { type LiveContext, liveContext, repoForPath } from './work/context.ts';
export { attachPlan, planHtml } from './work/plans.ts';
export { proposeNow } from './proposals/planner.ts';
export { pilotStats } from './insights/stats.ts';
export { closeTaskPr, mergePreview, mergeTask } from './landing/merge.ts';
export { cancelMergeRequest, requestAllMerges, requestMerge, requestMerges } from './landing/merge-requests.ts';
export { setAutoMerge } from './landing/auto-merge.ts';
export { type FixChecksResult, fixChecks } from './landing/fix-checks.ts';
export { type OpenTaskPrResult, openTaskPr } from './landing/open-pr.ts';
export {
  type DoctorReport,
  type RepoPatch,
  addRepo,
  archiveRepo,
  deleteRepo,
  doctorRepo,
  findRepo,
  listRepos,
  repoDeletionPreview,
  repoDetail,
  repoName,
  resumeRepo,
  unarchiveRepo,
  updateRepo,
} from './repos/repos.ts';
export { repoView } from './repos/repo-view.ts';
export {
  addReviewComment,
  deleteReviewComment,
  editReview,
  reopenReviewComment,
  resolveReviewComment,
  startReview,
  submitReview,
  taskReviews,
} from './landing/reviews.ts';
export { gracefulRestart } from './operations/restart.ts';
export { ChangeWatcher } from './operations/changes.ts';
export type { Scheduler } from './scheduler/scheduler.ts';
export {
  type DaemonInfo,
  type ReloadFacts,
  type Settings,
  type SettingsPatch,
  appSeen,
  daemonState,
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
} from './operations/settings.ts';
export { type TaskView, taskDetail, taskViews, withViews } from './work/task-views.ts';
export { addTask, editTask, findTask, listTasks, openPrTasks, removeTaskWorktree, taskRuns } from './work/tasks.ts';
export { approveTask, cancelTask, markDone, rejectTask, retryTask } from './landing/person-events.ts';
export { installNeeds } from './runs/install-needs.ts';
export { promptWarnings } from './work/prompt-paths.ts';
export { BUILDS_ON_STARTED, linkTasks, unlinkTasks } from './work/links.ts';
export type { TaskStatus } from '../domain/work/index.ts';
