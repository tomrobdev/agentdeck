// The database schema and its migrations.
import type { DatabaseSync } from 'node:sqlite';

/** The baseline schema run by migration step 1. Frozen: add new tables, columns and indexes as new steps. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL UNIQUE,
  base_branch TEXT NOT NULL DEFAULT 'main',
  test_cmd TEXT,
  allowed_tools TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  priority INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL,
  max_turns INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  branch TEXT,
  worktree TEXT,
  blocked_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS tasks_pick ON tasks(status, priority DESC, id);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  attempt INTEGER NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  outcome TEXT,
  exit_code INTEGER,
  session_id TEXT,
  num_turns INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  tests_passed INTEGER,
  result_text TEXT,
  log_path TEXT NOT NULL
);
-- Latest utilization reported by Claude's rate_limit_event, one row per window.
CREATE TABLE IF NOT EXISTS usage_windows (
  window TEXT PRIMARY KEY,          -- five_hour | seven_day
  utilization REAL NOT NULL,        -- 0..1
  resets_at INTEGER NOT NULL,       -- unix seconds
  status TEXT,
  observed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS planner_runs (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  outcome TEXT,
  proposed INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  log_path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  task_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export type Migration = string | ((db: DatabaseSync) => void);

function addColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

/**
 * Ordered schema migrations; the database's `PRAGMA user_version` is the number of steps already applied.
 * Only append: never edit or reorder a step that has shipped.
 */
export const MIGRATIONS: Migration[] = [
  // 1: baseline. Brings a database from any earlier (unversioned) release up to date; the column
  // additions are idempotent because old databases may already have some of them.
  (db) => {
    db.exec(SCHEMA);
    addColumn(db, 'repos', 'auto_approve', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'repos', 'planned_at', 'TEXT');
    addColumn(db, 'tasks', 'source', "TEXT NOT NULL DEFAULT 'manual'");
    addColumn(db, 'tasks', 'restarts', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'runs', 'pid', 'INTEGER');
    addColumn(db, 'planner_runs', 'pid', 'INTEGER');
  },
  // 2: runsForTask runs on every task view and every 500 ms per open log stream.
  'CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id, id)',
  // 3: repo integration. toolchain is detected at `repo add`; setup_cmd runs in each new worktree.
  'ALTER TABLE repos ADD COLUMN toolchain TEXT; ALTER TABLE repos ADD COLUMN setup_cmd TEXT;',
  // 4: a repo can be paused (doctor failed, setup failed, permissions refused); runs count refused tool uses.
  'ALTER TABLE repos ADD COLUMN paused_reason TEXT; ALTER TABLE runs ADD COLUMN denials INTEGER NOT NULL DEFAULT 0;',
  // 5: pull requests and task dependencies. pr_mode is off | draft | ready; pr_state is open | merged | closed.
  `ALTER TABLE repos ADD COLUMN pr_mode TEXT NOT NULL DEFAULT 'off';
   ALTER TABLE tasks ADD COLUMN pr_url TEXT;
   ALTER TABLE tasks ADD COLUMN pr_state TEXT;
   ALTER TABLE tasks ADD COLUMN after_task INTEGER;`,
  // 6: task history. One row per status change, written with the change itself (db/tasks.ts).
  `CREATE TABLE task_events (
     id INTEGER PRIMARY KEY,
     task_id INTEGER NOT NULL,
     type TEXT NOT NULL,           -- created | the TaskEvent type
     from_status TEXT, to_status TEXT,
     reason TEXT,
     at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX task_events_task ON task_events(task_id, id);`,
  // 7: plans attached to a task (domain/plan). One row per plan name; the HTML is parsed on read.
  `CREATE TABLE task_plans (
     id INTEGER PRIMARY KEY,
     task_id INTEGER NOT NULL,
     name TEXT NOT NULL,           -- the path on the task's branch, or the attached file's name
     source TEXT NOT NULL,         -- branch | attached
     html TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now')),
     UNIQUE (task_id, name)
   );`,
  // 8: merging a PR from the app. merge_method is squash | merge | rebase: the repo's default, and the one a task was merged with.
  `ALTER TABLE repos ADD COLUMN merge_method TEXT NOT NULL DEFAULT 'squash';
   ALTER TABLE tasks ADD COLUMN merge_method TEXT;`,
  // 9: keeping task branches up to date with their base. A run is a work run or a resolve run (merging the base
  // into the branch, which uses no attempt); auto_resolve lets the daemon start a resolve run on its own.
  `ALTER TABLE repos ADD COLUMN auto_resolve INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'work';`,
  // 10: worker sandbox (docs/adr/0001-worker-sandbox.md). network is a JSON array of hosts sandboxed commands may reach.
  `ALTER TABLE repos ADD COLUMN sandbox INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE repos ADD COLUMN network TEXT NOT NULL DEFAULT '[]';`,
  // 11: a task can name the plan and steps it carries out (docs/plans/plan-linked-tasks.html). plan_path is
  // repo-relative under docs/plans/; plan_steps is a JSON array of step ids, NULL for every unfinished step.
  `ALTER TABLE tasks ADD COLUMN plan_path TEXT;
   ALTER TABLE tasks ADD COLUMN plan_steps TEXT;`,
  // 12: archiving a repo (docs/plans/repo-archive.html). archived_at is when it was archived, NULL while it is active.
  'ALTER TABLE repos ADD COLUMN archived_at TEXT;',
  // 13: what a blocked worker said it needs (docs/plans/fewer-blocks.html): JSON { kind, items }, NULL when nothing.
  'ALTER TABLE tasks ADD COLUMN needs TEXT;',
];

/** Runs every step above the database's user_version in one transaction; returns how many ran. */
export function migrate(db: DatabaseSync, steps: Migration[] = MIGRATIONS): number {
  const current = (): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (current() >= steps.length) return 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    // Re-read under the write lock in case another process migrated first.
    const from = current();
    for (let i = from; i < steps.length; i++) {
      const step = steps[i];
      if (typeof step === 'string') db.exec(step);
      else step(db);
    }
    if (from < steps.length) db.exec(`PRAGMA user_version = ${steps.length}`);
    db.exec('COMMIT');
    return steps.length - from;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
