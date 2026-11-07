// From a row to its domain type: the one place a store's reads of tasks, repos and runs go through, so the domain type need not equal
// its row. `types-check.ts` checks each row against its mapper, and rule:models-not-rows checks the stores use them.
import { getColumns } from 'drizzle-orm';
import { DEFAULT_AUTO_MERGE_SKIP } from '../domain/pull-request/auto-merge.ts';
import type { Repo } from '../domain/repo/repo.ts';
import type { Run } from '../domain/run/run.ts';
import type { Task, TaskSummary } from '../domain/task/task.ts';
import { parseTextList } from '../domain/text.ts';
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
/**
 * A repo's row as a `Repo`: the flags are booleans and the JSON columns arrays. A malformed list reads as its default, which for the
 * repo's own tool rules is none (not the generic defaults, which could allow more than the repo meant).
 */
export const toRepo = (row: RepoRow): Repo => ({
  ...row,
  allowed_tools: row.allowed_tools === null ? null : parseTextList(row.allowed_tools),
  auto_approve: row.auto_approve === 1,
  auto_resolve: row.auto_resolve === 1,
  auto_unblock: row.auto_unblock === 1,
  sandbox: row.sandbox !== 0,
  network: parseTextList(row.network),
  auto_merge: row.auto_merge === 1,
  auto_merge_skip: parseTextList(row.auto_merge_skip, DEFAULT_AUTO_MERGE_SKIP),
});

/** The columns `fields` of a repo are stored in: the way back from `toRepo`. */
export function repoColumns(fields: Partial<Repo>): Partial<RepoRow> {
  const { allowed_tools, auto_approve, auto_resolve, auto_unblock, sandbox, network, auto_merge, auto_merge_skip, ...same } = fields;
  const bit = (on: boolean | undefined) => (on === undefined ? undefined : on ? 1 : 0);
  const json = (list: string[] | null | undefined) => (list ? JSON.stringify(list) : list);
  const columns = {
    ...same,
    allowed_tools: json(allowed_tools),
    auto_approve: bit(auto_approve),
    auto_resolve: bit(auto_resolve),
    auto_unblock: bit(auto_unblock),
    sandbox: bit(sandbox),
    network: json(network) ?? undefined,
    auto_merge: bit(auto_merge),
    auto_merge_skip: json(auto_merge_skip) ?? undefined,
  };
  return Object.fromEntries(Object.entries(columns).filter(([, v]) => v !== undefined));
}
export const toRun = (row: RunRow): Run => row;

/** What a `.get()` goes through: its row mapped, if there was one. */
export const mapFound = <Row, Model>(row: Row | undefined, toModel: (row: Row) => Model): Model | undefined =>
  row === undefined ? undefined : toModel(row);
