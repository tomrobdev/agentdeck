// Tables against their domain types, as Drizzle infers each row from tables.ts, so a column added to one and not the other fails
// `pnpm typecheck`. Tasks, repos and runs are read through a mapper (mappers.ts), so each row is checked against its mapper; the other
// tables' rows must still equal their domain type. Columns a domain type leaves out on purpose are named in the Omit.
import type { PlannerOutcome, PlannerRun } from '../domain/proposals/index.ts';
import type { MergeMethod, PrMode } from '../domain/repos/index.ts';
import type { PrState } from '../domain/landing/index.ts';
import type { Review, ReviewComment } from '../domain/landing/index.ts';
import type { RunKind, RunOutcome } from '../domain/runs/index.ts';
import type { TaskEventRow, TaskEventType } from '../domain/work/index.ts';
import type { TaskStatus } from '../domain/work/index.ts';
import type { LinkKind } from '../domain/work/index.ts';
import type {
  BlockedState,
  CancelledState,
  DoneState,
  FailedState,
  StateFields,
  Task,
  TaskSource,
  TaskState,
} from '../domain/work/index.ts';
import type {
  CheckoutColumn,
  LegacyTaskColumn,
  PlanColumn,
  PrColumn,
  StateColumn,
  TaskRow,
  toRepo,
  toRun,
  toTask,
  toTaskSummary,
} from './mappers.ts';
import type { plannerRuns, repos, reviewComments, reviews, runs, taskEvents, taskLinks, tasks } from './tables.ts';

/** The task columns the mapper folds into `pr`, `checkout`, `plan` and the task's state, which a `Task` has only once narrowed. */
type FoldedColumn = PrColumn | CheckoutColumn | PlanColumn | StateColumn;

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

check<Maps<typeof tasks.$inferSelect, typeof toTask, LegacyTaskColumn, FoldedColumn>>();
check<Maps<Omit<typeof tasks.$inferSelect, 'prompt'>, typeof toTaskSummary, LegacyTaskColumn, FoldedColumn>>();
check<Maps<typeof repos.$inferSelect, typeof toRepo>>();
check<Maps<typeof runs.$inferSelect, typeof toRun>>();

// A column added to tables.ts and absent from the mapper fails: the mapper doesn't take it, or takes it and its model has no such field.
type WithNewColumn = TaskRow & { new_column: string | null };
check<Equals<Maps<WithNewColumn, typeof toTask>, false>>();
check<Equals<Maps<WithNewColumn, (row: WithNewColumn) => Task>, false>>();
check<Maps<WithNewColumn, (row: WithNewColumn) => Task, never, FoldedColumn | 'new_column'>>();

check<Same<typeof plannerRuns.$inferSelect, PlannerRun>>();
check<Same<typeof taskEvents.$inferSelect, TaskEventRow>>();
check<Same<typeof reviews.$inferSelect, Review>>();
check<Same<typeof reviewComments.$inferSelect, ReviewComment>>();

// The narrowed text columns carry exactly their domain union.
check<Equals<TaskRow['status'], TaskStatus>>();
check<Equals<TaskRow['source'], TaskSource>>();
check<Equals<TaskRow['pr_state'], PrState | null>>();
check<Equals<TaskRow['merge_method'], MergeMethod | null>>();
check<Equals<TaskRow['done_by'], DoneState['done_by']>>();
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

// A task's state has every status and nothing else, and each field it carries is the column's own.
check<Equals<TaskState['status'], TaskStatus>>();
check<
  Equals<
    keyof StateFields,
    Exclude<keyof TaskRow & (keyof BlockedState | keyof CancelledState | keyof DoneState | keyof FailedState), 'status'>
  >
>();

// A field of a status can't be read until the task is narrowed to that status.
export const narrowed = (task: Task) => {
  // @ts-expect-error needs is only on a blocked task
  void task.needs;
  // @ts-expect-error a question is only on a blocked task
  void task.question;
  // @ts-expect-error a stop reason is only on a blocked, failed or cancelled task
  void task.stop_reason;
  // @ts-expect-error done_by is only on a done task
  void task.done_by;
  if (task.status === 'failed' || task.status === 'cancelled') {
    // @ts-expect-error a failed or cancelled task carries a stop reason, not needs
    void task.needs;
    return task.stop_reason;
  }
  if (task.status === 'done') {
    // @ts-expect-error a done task has no stop reason
    void task.stop_reason;
    return task.done_by;
  }
  if (task.status === 'blocked') return [task.stop_reason, task.needs, task.question];
  // @ts-expect-error a task waiting or running carries nothing about how it ended
  return task.stop_reason;
};
