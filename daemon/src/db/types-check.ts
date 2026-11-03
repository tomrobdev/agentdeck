// Each table's row, as Drizzle infers it from tables.ts, must equal its domain type, so a column added to one and
// not the other fails `pnpm typecheck`. Columns a domain type leaves out on purpose are named in the Omit.
import type { PlannerOutcome, PlannerRun } from '../domain/planner/proposals.ts';
import type { MergeMethod } from '../domain/pull-request/merge.ts';
import type { PrMode, PrState } from '../domain/pull-request/pr.ts';
import type { Review, ReviewComment } from '../domain/review/review.ts';
import type { Repo } from '../domain/repo/repo.ts';
import type { Run, RunKind, RunOutcome } from '../domain/run/run.ts';
import type { TaskEventRow, TaskEventType } from '../domain/task/history.ts';
import type { TaskStatus } from '../domain/task/lifecycle.ts';
import type { LinkKind } from '../domain/task/link.ts';
import type { Task, TaskSource } from '../domain/task/task.ts';
import type { plannerRuns, repos, reviewComments, reviews, runs, taskEvents, taskLinks, tasks } from './tables.ts';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** Compares the keys and whether each is nullable; unions such as PrMode narrow string columns. */
type Shape<T> = { [K in keyof T]-?: null extends T[K] ? 'nullable' : 'required' };
type Same<Row, Domain> = Equals<Shape<Row>, Shape<Domain>>;
export const check = <T extends true>(): T => true as T;

check<Same<typeof repos.$inferSelect, Repo>>();
// after_task: legacy, copied into task_links by migration 18; the store never reads or writes it.
check<Same<Omit<typeof tasks.$inferSelect, 'after_task'>, Task>>();
check<Same<typeof runs.$inferSelect, Run>>();
check<Same<typeof plannerRuns.$inferSelect, PlannerRun>>();
check<Same<typeof taskEvents.$inferSelect, TaskEventRow>>();
check<Same<typeof reviews.$inferSelect, Review>>();
check<Same<typeof reviewComments.$inferSelect, ReviewComment>>();

// The narrowed text columns carry exactly their domain union.
type TaskRow = typeof tasks.$inferSelect;
check<Equals<TaskRow['status'], TaskStatus>>();
check<Equals<TaskRow['source'], TaskSource>>();
check<Equals<TaskRow['pr_state'], PrState | null>>();
check<Equals<TaskRow['merge_method'], MergeMethod | null>>();
check<Equals<TaskRow['done_by'], Task['done_by']>>();
check<Equals<TaskRow['merge_request_method'], MergeMethod | null>>();
check<Equals<(typeof runs.$inferSelect)['outcome'], RunOutcome | null>>();
check<Equals<(typeof runs.$inferSelect)['kind'], RunKind>>();
check<Equals<(typeof plannerRuns.$inferSelect)['outcome'], PlannerOutcome | null>>();
check<Equals<(typeof taskLinks.$inferSelect)['kind'], LinkKind>>();
check<Equals<(typeof taskEvents.$inferSelect)['type'], TaskEventType>>();
check<Equals<(typeof taskEvents.$inferSelect)['from_status'], TaskStatus | null>>();
check<Equals<(typeof taskEvents.$inferSelect)['to_status'], TaskStatus | null>>();
check<Equals<(typeof repos.$inferSelect)['pr_mode'], PrMode>>();
check<Equals<(typeof repos.$inferSelect)['merge_method'], MergeMethod>>();
