// The tables as Drizzle sees them, mirroring the migrated schema in schema.ts. Dev tooling only for now:
// drizzle-kit reads this for Studio (pnpm db:studio) and the schema check (pnpm db:check). The stores still use
// hand-written SQL until the port in docs/plans/drizzle.html. Keys are column names, as in the domain types.
import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
export const repos = sqliteTable(
  'repos',
  {
    id: integer().primaryKey(),
    name: text().notNull(),
    path: text().notNull(),
    base_branch: text().default('main').notNull(),
    test_cmd: text(),
    allowed_tools: text(),
    created_at: text()
      .default(sql`datetime('now')`)
      .notNull(),
    auto_approve: integer().default(0).notNull(),
    planned_at: text(),
    toolchain: text(),
    setup_cmd: text(),
    paused_reason: text(),
    pr_mode: text().default('off').notNull(),
    merge_method: text().default('squash').notNull(),
    auto_resolve: integer().default(1).notNull(),
    sandbox: integer().default(1).notNull(),
    network: text().default('[]').notNull(),
    archived_at: text(),
    auto_merge: integer().default(0).notNull(),
    auto_merge_max_lines: integer().default(400).notNull(),
    auto_merge_skip: text().default('[".github/"]').notNull(),
  },
  (table) => [unique('repos_name_unique').on(table.name), unique('repos_path_unique').on(table.path)],
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: integer().primaryKey(),
    repo_id: integer()
      .notNull()
      .references(() => repos.id),
    title: text().notNull(),
    prompt: text().notNull(),
    status: text().default('queued').notNull(),
    priority: integer().default(0).notNull(),
    model: text().notNull(),
    max_turns: integer().notNull(),
    attempts: integer().default(0).notNull(),
    max_attempts: integer().notNull(),
    branch: text(),
    worktree: text(),
    stop_reason: text(),
    created_at: text()
      .default(sql`datetime('now')`)
      .notNull(),
    updated_at: text()
      .default(sql`datetime('now')`)
      .notNull(),
    source: text().default('manual').notNull(),
    restarts: integer().default(0).notNull(),
    pr_url: text(),
    pr_state: text(),
    after_task: integer(),
    merge_method: text(),
    plan_path: text(),
    plan_steps: text(),
    needs: text(),
    done_by: text(),
    auto_merge: integer(),
  },
  (table) => [index('tasks_pick').on(table.status, sql`priority DESC`, table.id)],
);

export const runs = sqliteTable(
  'runs',
  {
    id: integer().primaryKey(),
    task_id: integer()
      .notNull()
      .references(() => tasks.id),
    attempt: integer().notNull(),
    started_at: text()
      .default(sql`datetime('now')`)
      .notNull(),
    ended_at: text(),
    outcome: text(),
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
    kind: text().default('work').notNull(),
  },
  (table) => [index('runs_task').on(table.task_id, table.id)],
);

export const usageWindows = sqliteTable('usage_windows', {
  window: text().primaryKey(),
  utilization: real().notNull(),
  resets_at: integer().notNull(),
  status: text(),
  observed_at: text()
    .default(sql`datetime('now')`)
    .notNull(),
});

export const plannerRuns = sqliteTable('planner_runs', {
  id: integer().primaryKey(),
  repo_id: integer()
    .notNull()
    .references(() => repos.id),
  started_at: text()
    .default(sql`datetime('now')`)
    .notNull(),
  ended_at: text(),
  outcome: text(),
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
  task_id: integer(),
  created_at: text()
    .default(sql`datetime('now')`)
    .notNull(),
});

export const settings = sqliteTable('settings', {
  key: text().primaryKey(),
  value: text().notNull(),
});

export const taskEvents = sqliteTable(
  'task_events',
  {
    id: integer().primaryKey(),
    task_id: integer().notNull(),
    type: text().notNull(),
    from_status: text(),
    to_status: text(),
    reason: text(),
    at: text()
      .default(sql`datetime('now')`)
      .notNull(),
  },
  (table) => [index('task_events_task').on(table.task_id, table.id)],
);

export const taskPlans = sqliteTable('task_plans', {
  id: integer().primaryKey(),
  task_id: integer().notNull(),
  name: text().notNull(),
  source: text().notNull(),
  html: text().notNull(),
  created_at: text()
    .default(sql`datetime('now')`)
    .notNull(),
  updated_at: text()
    .default(sql`datetime('now')`)
    .notNull(),
});
