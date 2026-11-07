// From a row to its domain type: the one place a store's reads of tasks, repos and runs go through, so the domain type need not equal
// its row. `types-check.ts` checks each row against its mapper, and rule:models-not-rows checks the stores use them.
import { getColumns } from 'drizzle-orm';
import type { Repo } from '../domain/repo/repo.ts';
import type { Run } from '../domain/run/run.ts';
import type { UnblockQuestion } from '../domain/run/unblock.ts';
import { type Needs, isNeeds } from '../domain/task/needs.ts';
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

/** A stored JSON document, parsed; undefined when it is missing or malformed. */
function parseJson(json: string | null): unknown {
  if (!json) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** A task's `needs` column: null when it has none or it is malformed. */
function readNeeds(json: string | null): Needs | null {
  const n = parseJson(json);
  return isNeeds(n) ? n : null;
}

/** A task's `question` column: null when it has none or it is malformed. */
function readQuestion(json: string | null): UnblockQuestion | null {
  const q = parseJson(json) as Partial<UnblockQuestion> | null | undefined;
  return q && typeof q.question === 'string' && Array.isArray(q.options) ? { question: q.question, options: q.options.map(String) } : null;
}

/** A task's `plan_steps` column: null when it names none (every unfinished step) or is malformed. */
export function readSteps(json: string | null): string[] | null {
  const ids = parseJson(json);
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : null;
}

/** The task columns that carry a value, as the domain type has them. */
const taskValues = (row: TaskRow) => ({
  needs: readNeeds(row.needs),
  question: readQuestion(row.question),
  plan_steps: readSteps(row.plan_steps),
  auto_merge: row.auto_merge === null ? null : row.auto_merge === 1,
});

export const toTask = (row: TaskRow): Task => ({ ...row, ...taskValues(row) });
export const toTaskSummary = (row: TaskSummaryRow): TaskSummary => ({ ...row, ...taskValues(row as TaskRow) });
export const toRepo = (row: RepoRow): Repo => row;
export const toRun = (row: RunRow): Run => ({ ...row, tests_passed: row.tests_passed === null ? null : row.tests_passed === 1 });

/** A task or run value as its column stores it: the type of `T` with its parsed fields turned back. */
export type Stored<T> = {
  [K in keyof T]: K extends 'needs' | 'question' | 'plan_steps'
    ? Extract<T[K], null | undefined> | string
    : K extends 'auto_merge' | 'tests_passed'
      ? Extract<T[K], null | undefined> | number
      : T[K];
};

/**
 * The fields of a task or run as the columns (and the API, which keeps the stored shape) store them: a `Needs`, a question or
 * step ids as JSON, a flag as 1 or 0. A field not present stays absent; one present as undefined or null becomes null.
 */
export function stored<T extends object>(fields: T): Stored<T> {
  const f = fields as Record<string, unknown>;
  const out: Record<string, unknown> = { ...f };
  for (const key of ['needs', 'question', 'plan_steps']) if (key in f) out[key] = f[key] == null ? null : JSON.stringify(f[key]);
  for (const key of ['auto_merge', 'tests_passed']) if (key in f) out[key] = f[key] == null ? null : f[key] ? 1 : 0;
  return out as Stored<T>;
}

/** What a `.get()` goes through: its row mapped, if there was one. */
export const mapFound = <Row, Model>(row: Row | undefined, toModel: (row: Row) => Model): Model | undefined =>
  row === undefined ? undefined : toModel(row);
