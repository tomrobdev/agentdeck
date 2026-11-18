// The repositories the use cases reach the database through: interfaces application/ owns, in domain types, one file per context.
import type { DrainRepository, UsageRepository } from '#application/ports/repositories/capacity.ts';
import type { StatsRepository } from '#application/ports/repositories/insights.ts';
import type { ReviewRepository } from '#application/ports/repositories/landing.ts';
import type { ChangeRepository, NotificationRepository, SettingsRepository } from '#application/ports/repositories/operations.ts';
import type { PlannerRunRepository } from '#application/ports/repositories/proposals.ts';
import type { RepoRepository } from '#application/ports/repositories/repos.ts';
import type { RunRepository } from '#application/ports/repositories/runs.ts';
import type { PlanRepository, TaskEventRepository, TaskLinkRepository, TaskRepository } from '#application/ports/repositories/work.ts';

export type { DrainRepository, UsageRepository } from '#application/ports/repositories/capacity.ts';
export type { StatsRepository } from '#application/ports/repositories/insights.ts';
export type { ReviewRepository } from '#application/ports/repositories/landing.ts';
export type { ChangeRepository, NotificationRepository, SettingsRepository } from '#application/ports/repositories/operations.ts';
export type { PlannerRunRepository } from '#application/ports/repositories/proposals.ts';
export type { NewRepo, RepoRepository, RepoUpdate } from '#application/ports/repositories/repos.ts';
export type { RunRepository } from '#application/ports/repositories/runs.ts';
export type {
  NewTask,
  PlanRepository,
  TaskEdit,
  TaskEventRepository,
  TaskLinkRepository,
  TaskRepository,
} from '#application/ports/repositories/work.ts';

export type Repositories = TaskRepository &
  TaskEventRepository &
  TaskLinkRepository &
  PlanRepository &
  RepoRepository &
  RunRepository &
  PlannerRunRepository &
  ReviewRepository &
  StatsRepository &
  NotificationRepository &
  UsageRepository &
  DrainRepository &
  SettingsRepository &
  ChangeRepository;
