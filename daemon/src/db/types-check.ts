// Tables against their domain types, as Drizzle infers each row from tables.ts, so a column added to one and not the other fails
// `pnpm typecheck`. Tasks, repos and runs are read through a mapper (mappers.ts), so each row is checked against its mapper; the other
// tables' rows must still equal their domain type. Columns a domain type leaves out on purpose are named in the Omit.
import type { PlannerOutcome, PlannerRun } from '../domain/planner/proposals.ts';
import type { MergeMethod } from '../domain/pull-request/merge.ts';
import type { PrMode, PrState } from '../domain/pull-request/pr.ts';
import type { Review, ReviewComment } from '../domain/review/review.ts';
import type { RunKind, RunOutcome } from '../domain/run/run.ts';
import type { TaskEventRow, TaskEventType } from '../domain/task/history.ts';
import type { TaskStatus } from '../domain/task/lifecycle.ts';
import type { LinkKind } from '../domain/task/link.ts';
import type { Task, TaskSource } from '../domain/task/task.ts';
import type { LegacyTaskColumn, TaskRow, toRepo, toRun, toTask, toTaskSummary } from './mappers.ts';
import type { plannerRuns, repos, reviewComments, reviews, runs, taskEvents, taskLinks, tasks } from './tables.ts';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** Compares the keys and whether each is nullable; unions such as PrMode narrow string columns. */
type Shape<T> = { [K in keyof T]-?: null extends T[K] ? 'nullable' : 'required' };
type Same<Row, Domain> = Equals<Shape<Row>, Shape<Domain>>;
export const check = <T extends true>(): T => true as T;

/**
 * Whether `Mapper` accounts for every column of `Row`: it takes them all but the `Unread` ones, and each one it takes is a field of the
 * model it returns, or is named in `Folded` (read into a field of another name). What the model's fields contain, and any field with no
 * column of its name, the mapper's own return type checks.
 */
type Maps<Row, Mapper extends (row: never) => unknown, Unread extends keyof Row = never, Folded = never> =
  Equals<Exclude<keyof Row, Unread>, keyof Parameters<Mapper>[0]> extends true
    ? [Exclude<keyof Parameters<Mapper>[0], keyof ReturnType<Mapper> | Folded>] extends [never]
      ? true
      : false
    : false;

check<Maps<typeof tasks.$inferSelect, typeof toTask, LegacyTaskColumn>>();
check<Maps<Omit<typeof tasks.$inferSelect, 'prompt'>, typeof toTaskSummary, LegacyTaskColumn>>();
check<Maps<typeof repos.$inferSelect, typeof toRepo>>();
check<Maps<typeof runs.$inferSelect, typeof toRun>>();

// A column added to tables.ts and absent from the mapper fails: the mapper doesn't take it, or takes it and its model has no such field.
type WithNewColumn = TaskRow & { new_column: string | null };
check<Equals<Maps<WithNewColumn, typeof toTask>, false>>();
check<Equals<Maps<WithNewColumn, (row: WithNewColumn) => Task>, false>>();
check<Maps<WithNewColumn, (row: WithNewColumn) => Task, never, 'new_column'>>();

check<Same<typeof plannerRuns.$inferSelect, PlannerRun>>();
check<Same<typeof taskEvents.$inferSelect, TaskEventRow>>();
check<Same<typeof reviews.$inferSelect, Review>>();
check<Same<typeof reviewComments.$inferSelect, ReviewComment>>();

// The narrowed text columns carry exactly their domain union.
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
