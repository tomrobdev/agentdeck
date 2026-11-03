// The use cases the CLI and the HTTP API share, and the only application module they import. They throw ActionError on bad input.
export { readLog } from '../adapters/run-log.ts';
// The launchd service the daemon runs under, for the CLI's daemon commands.
export { install, restart, serviceStatus, start, stop, tailLog, uninstall } from '../adapters/service.ts';
export { type SyncReport, syncNow } from './sync.ts';
export { daemonHealth, daemonReport, restartNow } from './daemon/doctor.ts';
export type { Check as HealthCheck } from '../domain/daemon/health.ts';
export { ActionError } from './input.ts';
export * from './task/files.ts';
export { type LiveContext, liveContext, repoForPath } from './task/context.ts';
export { attachPlan, planHtml } from './plans.ts';
export { proposeNow } from './planner.ts';
export { pilotStats } from './run/stats.ts';
export { mergeAll, mergePreview, mergeTask } from './pull-request/pull-requests.ts';
export { cancelMergeRequest, requestMerge, requestMerges } from './pull-request/merge-requests.ts';
export { setAutoMerge } from './pull-request/auto-merge.ts';
export { type FixChecksResult, fixChecks } from './pull-request/fix-checks.ts';
export * from './repo/repos.ts';
export * from './review/reviews.ts';
export { gracefulRestart } from './scheduler/restart.ts';
export { ChangeWatcher } from './changes.ts';
export type { Scheduler } from './scheduler/scheduler.ts';
export * from './settings.ts';
export * from './task/task-views.ts';
export * from './task/tasks.ts';
export { promptWarnings } from './task/prompt-paths.ts';
export { linkTasks, unlinkTasks } from './task/links.ts';
export type { TaskStatus } from '../domain/task/lifecycle.ts';
