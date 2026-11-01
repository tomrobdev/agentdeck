// The use cases the CLI and the HTTP API share, and the only application module they import. They throw ActionError on bad input.
export { readLog } from '../adapters/run-log.ts';
// The launchd service the daemon runs under, for the CLI's daemon commands.
export { install, restart, serviceStatus, start, stop, tailLog, uninstall } from '../adapters/service.ts';
export { type SyncReport, syncNow } from './sync.ts';
export { ActionError } from './input.ts';
export * from './task/files.ts';
export { type LiveContext, liveContext, repoForPath } from './task/context.ts';
export { attachPlan, collectPlans, planHtml } from './plans.ts';
export { proposeNow } from './planner.ts';
export { pilotStats } from './run/stats.ts';
export { mergePreview, mergeTask } from './pull-request/pull-requests.ts';
export { setAutoMerge } from './pull-request/auto-merge.ts';
export * from './repo/repos.ts';
export { gracefulRestart } from './scheduler/restart.ts';
export type { Scheduler } from './scheduler/scheduler.ts';
export * from './settings.ts';
export * from './task/task-views.ts';
export * from './task/tasks.ts';
export { linkTasks, unlinkTasks } from './task/links.ts';
export type { TaskStatus } from '../domain/task/lifecycle.ts';
