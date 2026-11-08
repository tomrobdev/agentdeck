// From a row to its domain type: the one place a store's reads of tasks, repos and runs go through, so the domain type need not equal
// its row. `types-check.ts` checks each row against its mapper, and rule:models-not-rows checks the stores use them.
import { getColumns } from 'drizzle-orm';
import { type AutoMergeCheck, DEFAULT_AUTO_MERGE_SKIP } from '../domain/landing/index.ts';
import type { CheckCounts, StoredChecks } from '../domain/landing/index.ts';
import { type PrFields, pullRequestOf } from '../domain/landing/index.ts';
import { type Checkout, checkoutOf } from '../domain/work/index.ts';
import type { Repo } from '../domain/repos/index.ts';
import type { Run } from '../domain/runs/index.ts';
import { type Needs, type UnblockQuestion, isNeeds } from '../domain/work/index.ts';
import { type StateFields, type Task, type TaskState, type TaskSummary, stateFields } from '../domain/work/index.ts';
import { parseTextList, stored } from '../domain/shared/index.ts';
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

/** A stored auto-merge or merge request check: null when there is none or it is malformed. */
export function readCheck(json: string | null): AutoMergeCheck | null {
  const v = parseJson(json) as Partial<AutoMergeCheck> | null | undefined;
  if (!v || !['merge', 'wait', 'never'].includes(v.verdict as string) || !Array.isArray(v.reasons)) return null;
  const check: AutoMergeCheck = { verdict: v.verdict!, reasons: v.reasons.filter((r): r is string => typeof r === 'string') };
  if (v.conflict === true) check.conflict = true;
  return check;
}

/** A stored `pr_checks` column: null when there is none or it is malformed. */
function readStoredChecks(json: string | null): StoredChecks | null {
  const raw = parseJson(json) as Partial<StoredChecks> | null | undefined;
  if (!raw || !Array.isArray(raw.checks) || typeof raw.read_at !== 'string') return null;
  return { read_at: raw.read_at, head: raw.head ?? null, checks: raw.checks, notified: raw.notified === true };
}

/** A stored count of a PR's checks (`pr_checks_opened`, `pr_checks_merged`): null when there is none or it is malformed. */
export function readCounts(json: string | null): CheckCounts | null {
  const c = parseJson(json) as Partial<CheckCounts> | null | undefined;
  if (!c || typeof c.total !== 'number' || typeof c.failing !== 'number' || typeof c.pending !== 'number') return null;
  return { total: c.total, failing: c.failing, pending: c.pending };
}

/** The task columns the pull request is made of: a task has them as `pr`, not as fields. */
export type PrColumn = keyof PrFields;

/** The task columns the checkout is made of: a task has them as `checkout`. */
export type CheckoutColumn = keyof Checkout;

/** The task columns the plan link is made of: a task has them as `plan`. */
export type PlanColumn = 'plan_task' | 'plan_steps';

/** The task columns only some statuses carry: a task has them in its state, and no other status reads them. */
export type StateColumn = keyof StateFields;

/** A row without the columns that make up its pull request, checkout, plan link and state. */
function withoutValueColumns<R extends TaskSummaryRow>(row: R): Omit<R, PrColumn | CheckoutColumn | PlanColumn | StateColumn | 'status'> {
  const {
    status: _status,
    stop_reason: _stop_reason,
    needs: _needs,
    question: _question,
    done_by: _done_by,
    branch: _branch,
    worktree: _worktree,
    syncing_since: _syncing_since,
    plan_task: _plan_task,
    plan_steps: _plan_steps,
    pr_url: _url,
    pr_state: _state,
    merge_method: _method,
    auto_merge_check: _check,
    auto_merge_checked_at: _checked_at,
    pr_checks: _checks,
    pr_checks_opened: _opened,
    pr_checks_merged: _merged,
    merge_requested_at: _requested_at,
    merge_request_method: _request_method,
    merge_request_check: _request_check,
    ...rest
  } = row;
  return rest;
}

/**
 * The state a row is in: its status and the columns that status carries. A column of another status is ignored, so a row an older
 * daemon left with one (needs and a question on a cancelled task) reads like any other.
 */
function taskState(row: Pick<TaskSummaryRow, 'status' | StateColumn>): TaskState {
  const { status, stop_reason } = row;
  switch (status) {
    case 'done':
      return { status, done_by: row.done_by };
    case 'blocked':
      return { status, stop_reason, needs: readNeeds(row.needs), question: readQuestion(row.question) };
    case 'failed':
    case 'cancelled':
      return { status, stop_reason };
    default:
      return { status };
  }
}

/** The columns a task's state is stored in: the way back from `taskState`, with the columns of the other statuses cleared. */
export const stateColumns = (state: TaskState) => stored(stateFields(state));

/** The task columns that carry a value, as the domain type has them, and the pull request they make up. */
const taskValues = (row: TaskSummaryRow) => ({
  checkout: checkoutOf({ branch: row.branch, worktree: row.worktree, syncing_since: row.syncing_since }),
  plan: row.plan_task === null ? null : { task: row.plan_task, steps: readSteps(row.plan_steps) },
  auto_merge: row.auto_merge === null ? null : row.auto_merge === 1,
  pr: pullRequestOf({
    ...row,
    auto_merge_check: readCheck(row.auto_merge_check),
    merge_request_check: readCheck(row.merge_request_check),
    pr_checks: readStoredChecks(row.pr_checks),
    pr_checks_opened: readCounts(row.pr_checks_opened),
    pr_checks_merged: readCounts(row.pr_checks_merged),
  }),
});

export const toTask = (row: TaskRow): Task => ({ ...withoutValueColumns(row), ...taskValues(row), ...taskState(row) });
export const toTaskSummary = (row: TaskSummaryRow): TaskSummary => ({ ...withoutValueColumns(row), ...taskValues(row), ...taskState(row) });
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
  escalate: row.escalate !== 0,
  sandbox: row.sandbox !== 0,
  network: parseTextList(row.network),
  auto_merge: row.auto_merge === 1,
  auto_merge_skip: parseTextList(row.auto_merge_skip, DEFAULT_AUTO_MERGE_SKIP),
});

/** The columns `fields` of a repo are stored in: the way back from `toRepo`. */
export function repoColumns(fields: Partial<Repo>): Partial<RepoRow> {
  const { allowed_tools, auto_approve, auto_resolve, auto_unblock, escalate, sandbox, network, auto_merge, auto_merge_skip, ...same } =
    fields;
  const bit = (on: boolean | undefined) => (on === undefined ? undefined : on ? 1 : 0);
  const json = (list: string[] | null | undefined) => (list ? JSON.stringify(list) : list);
  const columns = {
    ...same,
    allowed_tools: json(allowed_tools),
    auto_approve: bit(auto_approve),
    auto_resolve: bit(auto_resolve),
    auto_unblock: bit(auto_unblock),
    escalate: bit(escalate),
    sandbox: bit(sandbox),
    network: json(network) ?? undefined,
    auto_merge: bit(auto_merge),
    auto_merge_skip: json(auto_merge_skip) ?? undefined,
  };
  return Object.fromEntries(Object.entries(columns).filter(([, v]) => v !== undefined));
}
export const toRun = (row: RunRow): Run => ({ ...row, tests_passed: row.tests_passed === null ? null : row.tests_passed === 1 });

/** What a `.get()` goes through: its row mapped, if there was one. */
export const mapFound = <Row, Model>(row: Row | undefined, toModel: (row: Row) => Model): Model | undefined =>
  row === undefined ? undefined : toModel(row);
