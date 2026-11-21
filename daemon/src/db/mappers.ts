// From a row to its domain type: the one place a store's reads of tasks, repos and runs go through, so the domain type need not equal its row.
import { getColumns } from 'drizzle-orm';
import { type AutoMergeCheck, DEFAULT_AUTO_MERGE_SKIP, type MergeReason } from '#domain/landing/index.ts';
import type { CheckCounts, StoredChecks } from '#domain/landing/index.ts';
import { type PrFields, pullRequestOf } from '#domain/landing/index.ts';
import { type Checkout, checkoutOf } from '#domain/work/index.ts';
import type { Repo } from '#domain/repos/index.ts';
import type { Run } from '#domain/runs/index.ts';
import { type Needs, type UnblockQuestion, isNeeds } from '#domain/work/index.ts';
import { type StateFields, type Task, type TaskState, type TaskSummary, stateFields } from '#domain/work/index.ts';
import { parseTextList, stored } from '#domain/shared/index.ts';
import type { PlanBranch } from '#domain/work/index.ts';
import { type planBranches, repos, runs, tasks } from '#db/tables.ts';

export type LegacyTaskColumn = 'after_task' | 'plan_path';

const { after_task: _after_task, plan_path: _plan_path, ...taskColumns } = getColumns(tasks);
export const TASK_COLUMNS = taskColumns;
const { prompt: _prompt, ...summaryColumns } = taskColumns;
export const SUMMARY_COLUMNS = summaryColumns;

export type TaskRow = Omit<typeof tasks.$inferSelect, LegacyTaskColumn>;
export type TaskSummaryRow = Omit<TaskRow, 'prompt'>;
export type RepoRow = typeof repos.$inferSelect;
export type RunRow = typeof runs.$inferSelect;

function parseJson(json: string | null): unknown {
  if (!json) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function readNeeds(json: string | null): Needs | null {
  const n = parseJson(json);
  return isNeeds(n) ? n : null;
}

function readQuestion(json: string | null): UnblockQuestion | null {
  const q = parseJson(json) as Partial<UnblockQuestion> | null | undefined;
  return q && typeof q.question === 'string' && Array.isArray(q.options) ? { question: q.question, options: q.options.map(String) } : null;
}

export function readSteps(json: string | null): string[] | null {
  const ids = parseJson(json);
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : null;
}

function readReason(raw: unknown): MergeReason | null {
  if (typeof raw === 'string') return { kind: 'other', text: raw };
  const r = raw as Partial<MergeReason> | null;
  return r && typeof r === 'object' && typeof r.kind === 'string' && typeof r.text === 'string' ? { kind: r.kind, text: r.text } : null;
}

export function readCheck(json: string | null): AutoMergeCheck | null {
  const v = parseJson(json) as (Omit<Partial<AutoMergeCheck>, 'reasons'> & { reasons?: unknown }) | null | undefined;
  const verdict = v?.verdict;
  if (!v || !verdict || !['merge', 'wait', 'never'].includes(verdict) || !Array.isArray(v.reasons)) return null;
  const reasons = v.reasons.map(readReason).filter((r): r is MergeReason => r !== null);
  const check: AutoMergeCheck = { verdict, reasons };
  if (v.conflict === true) check.conflict = true;
  return check;
}

function readStoredChecks(json: string | null): StoredChecks | null {
  const raw = parseJson(json) as Partial<StoredChecks> | null | undefined;
  if (!raw || !Array.isArray(raw.checks) || typeof raw.read_at !== 'string') return null;
  return { read_at: raw.read_at, head: raw.head ?? null, checks: raw.checks, notified: raw.notified === true };
}

export function readCounts(json: string | null): CheckCounts | null {
  const c = parseJson(json) as Partial<CheckCounts> | null | undefined;
  if (!c || typeof c.total !== 'number' || typeof c.failing !== 'number' || typeof c.pending !== 'number') return null;
  const failures = Array.isArray(c.failures)
    ? c.failures.flatMap((f) =>
        f && typeof f.name === 'string' ? [{ name: f.name, step: typeof f.step === 'string' ? f.step : null }] : [],
      )
    : undefined;
  return { total: c.total, failing: c.failing, pending: c.pending, ...(failures ? { failures } : {}) };
}

export type PrColumn = keyof PrFields;

export type CheckoutColumn = keyof Checkout;

export type PlanColumn = 'plan_task' | 'plan_steps';

export type StateColumn = keyof StateFields;

function withoutValueColumns<R extends TaskSummaryRow>(row: R): Omit<R, PrColumn | CheckoutColumn | PlanColumn | StateColumn | 'status'> {
  const {
    status: _status,
    stop_reason: _stop_reason,
    needs: _needs,
    question: _question,
    done_by: _done_by,
    park_reason: _park_reason,
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
    case 'parked':
      return { status, park_reason: row.park_reason };
    case 'proposed':
    case 'queued':
    case 'running':
    case 'cancel_requested':
      return { status };
  }
}

export const stateColumns = (state: TaskState) => stored(stateFields(state));

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
export const toRepo = (row: RepoRow): Repo => ({
  ...row,
  allowed_tools: row.allowed_tools === null ? null : parseTextList(row.allowed_tools),
  auto_approve: row.auto_approve === 1,
  auto_resolve: row.auto_resolve === 1,
  auto_unblock: row.auto_unblock === 1,
  auto_review: row.auto_review === 1,
  escalate: row.escalate !== 0,
  sandbox: row.sandbox !== 0,
  network: parseTextList(row.network),
  auto_merge: row.auto_merge === 1,
  ci_not_run_ok: row.ci_not_run_ok === 1,
  auto_merge_skip: parseTextList(row.auto_merge_skip, DEFAULT_AUTO_MERGE_SKIP),
  union_paths: parseTextList(row.union_paths),
  generated_paths: parseTextList(row.generated_paths),
  issues: row.issues === 1,
  issues_allow: parseTextList(row.issues_allow),
});

export function repoColumns(fields: Partial<Repo>): Partial<RepoRow> {
  const {
    allowed_tools,
    auto_approve,
    auto_resolve,
    auto_unblock,
    auto_review,
    escalate,
    sandbox,
    network,
    auto_merge,
    ci_not_run_ok,
    auto_merge_skip,
    union_paths,
    generated_paths,
    issues,
    issues_allow,
    ...same
  } = fields;
  const bit = (on: boolean | undefined) => (on === undefined ? undefined : on ? 1 : 0);
  const json = (list: string[] | null | undefined) => (list ? JSON.stringify(list) : list);
  const columns = {
    ...same,
    allowed_tools: json(allowed_tools),
    auto_approve: bit(auto_approve),
    auto_resolve: bit(auto_resolve),
    auto_unblock: bit(auto_unblock),
    auto_review: bit(auto_review),
    escalate: bit(escalate),
    sandbox: bit(sandbox),
    network: json(network) ?? undefined,
    auto_merge: bit(auto_merge),
    ci_not_run_ok: bit(ci_not_run_ok),
    auto_merge_skip: json(auto_merge_skip) ?? undefined,
    union_paths: json(union_paths) ?? undefined,
    generated_paths: json(generated_paths) ?? undefined,
    issues: bit(issues),
    issues_allow: json(issues_allow) ?? undefined,
  };
  return Object.fromEntries(Object.entries(columns).filter(([, v]) => v !== undefined));
}
const flag = (v: number | null): boolean | null => (v === null ? null : v === 1);

export const toRun = (row: RunRow): Run => ({
  ...row,
  tests_passed: flag(row.tests_passed),
  last_test_failed: flag(row.last_test_failed),
  changed_paths: row.changed_paths === null ? null : parseTextList(row.changed_paths),
});

export type PlanBranchRow = typeof planBranches.$inferSelect;

export const toPlanBranch = (row: PlanBranchRow): PlanBranch => ({ ...row });

export const mapFound = <Row, Model>(row: Row | undefined, toModel: (row: Row) => Model): Model | undefined =>
  row === undefined ? undefined : toModel(row);
