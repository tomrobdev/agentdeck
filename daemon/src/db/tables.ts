// The tables as Drizzle sees them, mirroring the migrated schema in schema.ts.
import { sql } from 'drizzle-orm';
import type { PlannerRunId, RepoId, ReviewId, RunId, TaskId } from '#domain/shared/index.ts';
import type { PlannerOutcome } from '#domain/proposals/index.ts';
import type { MergeMethod, PrMode } from '#domain/repos/index.ts';
import type { PrState, ReviewAuthor } from '#domain/landing/index.ts';
import type { RunEnd, RunKind, RunOutcome } from '#domain/runs/index.ts';
import type { TaskEventType } from '#domain/work/index.ts';
import type { LinkKind } from '#domain/work/index.ts';
import type { TaskStatus } from '#domain/work/index.ts';
import type { IssueReport, TaskSource } from '#domain/work/index.ts';
import type { LandingPolicy, PlanBranchStatus, PlanReviewState } from '#domain/work/index.ts';
import { index, integer, primaryKey, real, sqliteTable, text, unique, uniqueIndex } from 'drizzle-orm/sqlite-core';

// guard: a column default is an expression SQLite evaluates on insert, which the builder can only take as raw SQL
const NOW_DEFAULT = sql`datetime('now')`;

export const repos = sqliteTable(
  'repos',
  {
    id: integer().$type<RepoId>().primaryKey(),
    name: text().notNull(),
    path: text().notNull(),
    base_branch: text().default('main').notNull(),
    test_cmd: text(),
    allowed_tools: text(),
    created_at: text().default(NOW_DEFAULT).notNull(),
    auto_approve: integer().default(0).notNull(),
    proposed_at: text(),
    toolchain: text(),
    setup_cmd: text(),
    paused_reason: text(),
    pr_mode: text().$type<PrMode>().default('off').notNull(),
    merge_method: text().$type<MergeMethod>().default('squash').notNull(),
    auto_resolve: integer().default(1).notNull(),
    sandbox: integer().default(1).notNull(),
    network: text().default('[]').notNull(),
    archived_at: text(),
    auto_merge: integer().default(0).notNull(),
    auto_merge_max_lines: integer().default(400).notNull(),
    auto_merge_skip: text().default('[".github/"]').notNull(),
    auto_unblock: integer().default(0).notNull(),
    model: text(),
    auto_review: integer().default(0).notNull(),
    escalate: integer().default(1).notNull(),
    code_comment_max_lines: integer().default(5).notNull(),
    code_comment_max_percent: integer().default(5).notNull(),
    ci_not_run_ok: integer().default(0).notNull(),
    union_paths: text().default('[]').notNull(),
    generated_paths: text().default('[]').notNull(),
    generated_cmd: text(),
    max_concurrent: integer().default(1).notNull(),
    issues: integer().default(0).notNull(),
    issues_allow: text().default('[]').notNull(),
  },
  (table) => [unique('repos_name_unique').on(table.name), unique('repos_path_unique').on(table.path)],
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: integer().$type<TaskId>().primaryKey(),
    repo_id: integer()
      .$type<RepoId>()
      .notNull()
      .references(() => repos.id),
    title: text().notNull(),
    prompt: text().notNull(),
    status: text().$type<TaskStatus>().default('queued').notNull(),
    priority: integer().default(0).notNull(),
    model: text().notNull(),
    max_turns: integer().notNull(),
    attempts: integer().default(0).notNull(),
    max_attempts: integer().notNull(),
    branch: text(),
    worktree: text(),
    stop_reason: text(),
    created_at: text().default(NOW_DEFAULT).notNull(),
    updated_at: text().default(NOW_DEFAULT).notNull(),
    source: text().$type<TaskSource>().default('manual').notNull(),
    restarts: integer().default(0).notNull(),
    pr_url: text(),
    pr_state: text().$type<PrState>(),
    after_task: integer(),
    merge_method: text().$type<MergeMethod>(),
    plan_path: text(),
    plan_steps: text(),
    needs: text(),
    done_by: text().$type<'person'>(),
    auto_merge: integer(),
    auto_merge_check: text(),
    auto_merge_checked_at: text(),
    pr_checks_opened: text(),
    pr_checks_merged: text(),
    merge_requested_at: text(),
    merge_request_method: text().$type<MergeMethod>(),
    merge_request_check: text(),
    plan_task: integer().$type<TaskId>(),
    pr_checks: text(),
    syncing_since: text(),
    question: text(),
    park_reason: text(),
    target: text(),
  },
  // guard: an index column in descending order, which the index builder takes only as raw SQL
  (table) => [index('tasks_pick').on(table.status, sql`priority DESC`, table.id)],
);

export const runs = sqliteTable(
  'runs',
  {
    id: integer().$type<RunId>().primaryKey(),
    task_id: integer()
      .$type<TaskId>()
      .notNull()
      .references(() => tasks.id),
    attempt: integer().notNull(),
    started_at: text().default(NOW_DEFAULT).notNull(),
    ended_at: text(),
    outcome: text().$type<RunOutcome>(),
    exit_code: integer(),
    session_id: text(),
    num_turns: integer(),
    input_tokens: integer().default(0).notNull(),
    output_tokens: integer().default(0).notNull(),
    cache_read_tokens: integer().default(0).notNull(),
    cache_write_tokens: integer().default(0).notNull(),
    cost_usd: real().default(0).notNull(),
    tests_passed: integer(),
    result_text: text(),
    log_path: text().notNull(),
    pid: integer(),
    denials: integer().default(0).notNull(),
    kind: text().$type<RunKind>().default('work').notNull(),
    live_turns: integer().default(0).notNull(),
    live_tool: text(),
    pid_at: text(),
    model: text(),
    model_id: text(),
    diff_hash: text(),
    run_end: text().$type<RunEnd>(),
    last_test_failed: integer(),
    base_commit: text(),
    code_comment_lines: integer(),
    code_comment_percent: real(),
    changed_paths: text(),
  },
  (table) => [index('runs_task').on(table.task_id, table.id)],
);

export const usageWindows = sqliteTable('usage_windows', {
  window: text().primaryKey(),
  utilization: real().notNull(),
  resets_at: integer().notNull(),
  status: text(),
  observed_at: text().default(NOW_DEFAULT).notNull(),
});

export const usageSamples = sqliteTable(
  'usage_samples',
  {
    id: integer().primaryKey(),
    window: text().notNull(),
    utilization: real().notNull(),
    resets_at: integer().notNull(),
    observed_at: text().default(NOW_DEFAULT).notNull(),
  },
  (table) => [index('usage_samples_window').on(table.window, table.id)],
);

export const plannerRuns = sqliteTable('planner_runs', {
  id: integer().$type<PlannerRunId>().primaryKey(),
  repo_id: integer()
    .$type<RepoId>()
    .notNull()
    .references(() => repos.id),
  started_at: text().default(NOW_DEFAULT).notNull(),
  ended_at: text(),
  outcome: text().$type<PlannerOutcome>(),
  proposed: integer().default(0).notNull(),
  note: text(),
  log_path: text().notNull(),
  pid: integer(),
});

export const notifications = sqliteTable('notifications', {
  id: integer().primaryKey(),
  kind: text().notNull(),
  title: text().notNull(),
  body: text().notNull(),
  task_id: integer().$type<TaskId>(),
  created_at: text().default(NOW_DEFAULT).notNull(),
});

export const settings = sqliteTable('settings', {
  key: text().primaryKey(),
  value: text().notNull(),
});

export const taskEvents = sqliteTable(
  'task_events',
  {
    id: integer().primaryKey(),
    task_id: integer().$type<TaskId>().notNull(),
    type: text().$type<TaskEventType>().notNull(),
    from_status: text().$type<TaskStatus>(),
    to_status: text().$type<TaskStatus>(),
    reason: text(),
    at: text().default(NOW_DEFAULT).notNull(),
    follow_up_pending: integer().default(0).notNull(),
  },
  (table) => [index('task_events_task').on(table.task_id, table.id)],
);

export const taskLinks = sqliteTable(
  'task_links',
  {
    task_id: integer()
      .$type<TaskId>()
      .notNull()
      .references(() => tasks.id),
    on_task: integer()
      .$type<TaskId>()
      .notNull()
      .references(() => tasks.id),
    kind: text().$type<LinkKind>().default('builds_on').notNull(),
    created_at: text().default(NOW_DEFAULT).notNull(),
  },
  (table) => [primaryKey({ columns: [table.task_id, table.on_task] }), index('task_links_on').on(table.on_task)],
);

export const taskPlans = sqliteTable('task_plans', {
  id: integer().primaryKey(),
  task_id: integer().$type<TaskId>().notNull(),
  name: text().notNull(),
  source: text().notNull(),
  html: text().notNull(),
  created_at: text().default(NOW_DEFAULT).notNull(),
  updated_at: text().default(NOW_DEFAULT).notNull(),
});

export const planBranches = sqliteTable(
  'plan_branches',
  {
    id: integer().primaryKey(),
    plan_task: integer()
      .$type<TaskId>()
      .notNull()
      .references(() => tasks.id),
    repo_id: integer()
      .$type<RepoId>()
      .notNull()
      .references(() => repos.id),
    name: text().notNull(),
    base: text().notNull(),
    status: text().$type<PlanBranchStatus>().default('open').notNull(),
    head_commit: text(),
    pr_url: text(),
    created_at: text().default(NOW_DEFAULT).notNull(),
    updated_at: text().default(NOW_DEFAULT).notNull(),
    synced_at: text(),
    ahead_lines: integer(),
    landing_policy: text().$type<LandingPolicy>().default('person').notNull(),
    land_order: integer(),
    land_error: text(),
    landed_commit: text(),
    landed_from: text(),
    review: text().$type<PlanReviewState>(),
    review_head: text(),
    review_summary: text(),
  },
  (table) => [uniqueIndex('plan_branches_plan_repo').on(table.plan_task, table.repo_id)],
);

export const reviews = sqliteTable(
  'reviews',
  {
    id: integer().$type<ReviewId>().primaryKey(),
    task_id: integer()
      .$type<TaskId>()
      .notNull()
      .references(() => tasks.id),
    kind: text(),
    body: text().default('').notNull(),
    created_at: text().default(NOW_DEFAULT).notNull(),
    submitted_at: text(),
    by: text().$type<ReviewAuthor>().default('person').notNull(),
    head_commit: text(),
    diff_hash: text(),
  },
  (table) => [index('reviews_task').on(table.task_id, table.id)],
);

export const reviewComments = sqliteTable(
  'review_comments',
  {
    id: integer().primaryKey(),
    review_id: integer()
      .$type<ReviewId>()
      .notNull()
      .references(() => reviews.id),
    path: text().notNull(),
    line: integer().notNull(),
    side: text().notNull(),
    head_commit: text().notNull(),
    body: text().notNull(),
    answer: text(),
    state: text().default('open').notNull(),
    created_at: text().default(NOW_DEFAULT).notNull(),
    updated_at: text().default(NOW_DEFAULT).notNull(),
  },
  (table) => [index('review_comments_review').on(table.review_id, table.id)],
);

export const taskIssues = sqliteTable(
  'task_issues',
  {
    task_id: integer()
      .$type<TaskId>()
      .primaryKey()
      .references(() => tasks.id),
    repo_id: integer()
      .$type<RepoId>()
      .notNull()
      .references(() => repos.id),
    number: integer().notNull(),
    url: text().notNull(),
    reported: text().$type<IssueReport>(),
    reported_at: text(),
  },
  (table) => [uniqueIndex('task_issues_repo_number').on(table.repo_id, table.number)],
);
