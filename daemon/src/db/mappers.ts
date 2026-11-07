// From a row to its domain type: the one place a store's reads of tasks, repos and runs go through, so the domain type need not equal
// its row. `types-check.ts` checks each row against its mapper, and rule:models-not-rows checks the stores use them.
import { getColumns } from 'drizzle-orm';
import type { Repo } from '../domain/repo/repo.ts';
import type { Run } from '../domain/run/run.ts';
import type { Task, TaskSummary } from '../domain/task/task.ts';
import { repos, runs, tasks } from './tables.ts';

/** Legacy task columns, which nothing reads or writes: `after_task` went to task_links in migration 18, and `plan_path` stopped being written in 24. */
export type LegacyTaskColumn = 'after_task' | 'plan_path';

/** A task's columns, without the legacy ones. */
const { after_task: _after_task, plan_path: _plan_path, ...taskColumns } = getColumns(tasks);
export const TASK_COLUMNS = taskColumns;
/** Every column but the prompt, for lists. */
const { prompt: _prompt, ...summaryColumns } = taskColumns;
export const SUMMARY_COLUMNS = summaryColumns;

export type TaskRow = Omit<typeof tasks.$inferSelect, LegacyTaskColumn>;
export type TaskSummaryRow = Omit<TaskRow, 'prompt'>;
export type RepoRow = typeof repos.$inferSelect;
export type RunRow = typeof runs.$inferSelect;

export const toTask = (row: TaskRow): Task => row;
export const toTaskSummary = (row: TaskSummaryRow): TaskSummary => row;
export const toRepo = (row: RepoRow): Repo => row;
export const toRun = (row: RunRow): Run => row;

/** What a `.get()` goes through: its row mapped, if there was one. */
export const mapFound = <Row, Model>(row: Row | undefined, toModel: (row: Row) => Model): Model | undefined =>
  row === undefined ? undefined : toModel(row);
