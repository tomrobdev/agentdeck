// The repositories the use cases reach the database through: interfaces application/ owns, in domain types, one file per
// context. db/ implements them (`openDb` returns something that satisfies `Repositories`). An interface lists what use cases
// call and no more (test/repositories-used.test.ts); the rest of what the database offers stays on db/'s own `Db`.
import type { UsageRepository } from './capacity.ts';
import type { StatsRepository } from './insights.ts';
import type { ReviewRepository } from './landing.ts';
import type { ChangeRepository, NotificationRepository, SettingsRepository } from './operations.ts';
import type { PlannerRunRepository } from './proposals.ts';
import type { RepoRepository } from './repos.ts';
import type { RunRepository } from './runs.ts';
import type { PlanRepository, TaskEventRepository, TaskLinkRepository, TaskRepository } from './work.ts';

export type { UsageRepository } from './capacity.ts';
export type { StatsRepository } from './insights.ts';
export type { ReviewRepository } from './landing.ts';
export type { ChangeRepository, NotificationRepository, SettingsRepository } from './operations.ts';
export type { PlannerRunRepository } from './proposals.ts';
export type { NewRepo, RepoRepository, RepoUpdate } from './repos.ts';
export type { RunRepository } from './runs.ts';
export type { NewTask, PlanRepository, TaskEdit, TaskEventRepository, TaskLinkRepository, TaskRepository } from './work.ts';

/** Everything the use cases read and write, one object. */
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
  SettingsRepository &
  ChangeRepository;
