// The database schema and its migrations.
import type { DatabaseSync } from 'node:sqlite';

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
  // 14: who said a task is done (docs/plans/manual-moves.html): 'person' when mark_done set it, NULL otherwise.
  'ALTER TABLE tasks ADD COLUMN done_by TEXT;',
  // 15: the stop reason, named for the domain language (docs/plans/domain-model.html).
  'ALTER TABLE tasks RENAME COLUMN blocked_reason TO stop_reason;',
  // 16: a paused repo notifies with its own kind, `paused`, instead of `hold`. Whoever listened for `hold` keeps hearing both.
  `UPDATE settings SET value = value || ',paused'
   WHERE key = 'notify_events' AND ',' || value || ',' LIKE '%,hold,%' AND ',' || value || ',' NOT LIKE '%,paused,%';`,
  // 17: auto-merge (docs/plans/auto-merge.html). auto_merge_skip is a JSON array of path prefixes that need a person;
  // a task's auto_merge is NULL (its repo's), 0 or 1.
  `ALTER TABLE repos ADD COLUMN auto_merge INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE repos ADD COLUMN auto_merge_max_lines INTEGER NOT NULL DEFAULT 400;
   ALTER TABLE repos ADD COLUMN auto_merge_skip TEXT NOT NULL DEFAULT '[".github/"]';
   ALTER TABLE tasks ADD COLUMN auto_merge INTEGER;`,
  // 18: task links (docs/plans/task-links.html). kind is builds_on | after. after_task is copied in and no longer read.
  `CREATE TABLE task_links (
     task_id INTEGER NOT NULL REFERENCES tasks(id),
     on_task INTEGER NOT NULL REFERENCES tasks(id),
     kind TEXT NOT NULL DEFAULT 'builds_on',
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (task_id, on_task)
   );
   CREATE INDEX task_links_on ON task_links(on_task);
   INSERT INTO task_links (task_id, on_task, kind) SELECT id, after_task, 'builds_on' FROM tasks WHERE after_task IS NOT NULL;`,
  // 19: the latest auto-merge check of a done task's open PR (docs/plans/auto-merge-view.html): JSON { verdict, reasons },
  // NULL when none; auto_merge_checked_at is when the PR refresh made it.
  `ALTER TABLE tasks ADD COLUMN auto_merge_check TEXT;
   ALTER TABLE tasks ADD COLUMN auto_merge_checked_at TEXT;`,
  // 20: reviews made in the dashboard (docs/plans/review-merge.html). A review is a draft until submitted_at is set; kind is
  // comment | request_changes. A comment's state is open | answered | resolved; side is old | new.
  `CREATE TABLE reviews (
     id INTEGER PRIMARY KEY,
     task_id INTEGER NOT NULL REFERENCES tasks(id),
     kind TEXT,
     body TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     submitted_at TEXT
   );
   CREATE INDEX reviews_task ON reviews(task_id, id);
   CREATE TABLE review_comments (
     id INTEGER PRIMARY KEY,
     review_id INTEGER NOT NULL REFERENCES reviews(id),
     path TEXT NOT NULL,
     line INTEGER NOT NULL,
     side TEXT NOT NULL,
     head_commit TEXT NOT NULL,
     body TEXT NOT NULL,
     answer TEXT,
     state TEXT NOT NULL DEFAULT 'open',
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX review_comments_review ON review_comments(review_id, id);`,
  // 21: what a live run is doing: turns so far and the last tool call, kept from its stream while it runs.
  `ALTER TABLE runs ADD COLUMN live_turns INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE runs ADD COLUMN live_tool TEXT;`,
  // 22: what the pilot scorecard needs and nothing kept. usage_samples is a history of usage readings, appended when a
  // window's reading changes; pr_checks_opened / pr_checks_merged are JSON { total, failing, pending } of a PR's checks.
  `CREATE TABLE usage_samples (
     id INTEGER PRIMARY KEY,
     window TEXT NOT NULL,
     utilization REAL NOT NULL,
     resets_at INTEGER NOT NULL,
     observed_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX usage_samples_window ON usage_samples(window, id);
   ALTER TABLE tasks ADD COLUMN pr_checks_opened TEXT;
   ALTER TABLE tasks ADD COLUMN pr_checks_merged TEXT;`,
  // 23: merge requests (docs/plans/merge-requests.html). merge_requested_at is when a person asked the daemon to merge the
  // task's PR once it is ready (NULL: no request); merge_request_check is the last check's JSON { verdict, reasons }.
  `ALTER TABLE tasks ADD COLUMN merge_requested_at TEXT;
   ALTER TABLE tasks ADD COLUMN merge_request_method TEXT;
   ALTER TABLE tasks ADD COLUMN merge_request_check TEXT;`,
  // 24: plans live in AgentDeck, named after the task they belong to. plan_task is the task whose plan this one follows
  // (itself when its own plan was given with --plan); plan_steps names that plan's steps. plan_path is no longer written.
  `ALTER TABLE tasks ADD COLUMN plan_task INTEGER;`,
  // 25: when a run's pid was stored. Its claude started then, which can be minutes after the run row (setup, a sync),
  // so crash recovery and the doctor tell our claude from a reused pid by this time, not by started_at.
  `ALTER TABLE runs ADD COLUMN pid_at TEXT;`,
  // 26: an open PR's latest checks, one by one (domain/landing/checks.ts StoredChecks): JSON { read_at, head, checks,
  // notified }, written by the PR refresh; notified says a person was told they fail. NULL until the PR's checks are read.
  `ALTER TABLE tasks ADD COLUMN pr_checks TEXT;`,
  // 27: when a sync of the task's branch began (NULL when none is running). Syncs run in the daemon only, so the CLI
  // reads this to see one; the daemon clears every marker on start.
  `ALTER TABLE tasks ADD COLUMN syncing_since TEXT;`,
  // 28: unblock runs (domain/runs/unblock.ts). auto_unblock lets the daemon start one on its own when a task blocks (off by
  // default); question is the JSON { question, options } one left on a blocked task, cleared when the task is queued again.
  `ALTER TABLE repos ADD COLUMN auto_unblock INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE tasks ADD COLUMN question TEXT;`,
  // 29: the planner's last run is when the repo last had tasks proposed, so planned_at is now proposed_at.
  'ALTER TABLE repos RENAME COLUMN planned_at TO proposed_at;',
  // 30: task_events as the outbox (domain/work/follow-ups.ts). follow_up_pending is 1 while a status change's follow-ups
  // are still to run, and the daemon's tick runs them. Every row before this step, and every row older code writes, reads
  // 0: their follow-ups ran inline, so they never run twice.
  'ALTER TABLE task_events ADD COLUMN follow_up_pending INTEGER NOT NULL DEFAULT 0;',
  // 31: models. repos.model is the model a new task of the repo
  // takes when it names none (NULL follows the default_model setting). runs.model is the model a run was started with and
  // runs.model_id the exact id claude's init line named; both are NULL on rows from older code, which read as unknown.
  `ALTER TABLE repos ADD COLUMN model TEXT;
   ALTER TABLE runs ADD COLUMN model TEXT;
   ALTER TABLE runs ADD COLUMN model_id TEXT;`,
  // 32: review runs (domain/runs/review.ts). repos.auto_review lets the daemon start one when a task is done (off by
  // default). reviews.by is who made a review (every earlier one was a person's); head_commit and diff_hash are the head
  // and the patch-id of the changes it read, set at submit (NULL on older rows). runs.diff_hash is the diff a review run
  // was started for, NULL for other kinds.
  `ALTER TABLE repos ADD COLUMN auto_review INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE reviews ADD COLUMN by TEXT NOT NULL DEFAULT 'person';
   ALTER TABLE reviews ADD COLUMN head_commit TEXT;
   ALTER TABLE reviews ADD COLUMN diff_hash TEXT;
   ALTER TABLE runs ADD COLUMN diff_hash TEXT;`,
  // 33: review_due, a new notification kind (domain/operations/review-due.ts), on by default. A stored notify_events
  // does not take the setting's default, so the kind is added to it, unless a person turned every kind off.
  `UPDATE settings SET value = value || ',review_due'
   WHERE key = 'notify_events' AND value <> '' AND ',' || value || ',' NOT LIKE '%,review_due,%';`,
  // 34: how a failed or blocked work run ended (domain/runs/translate/summary.ts's RunEnd) and whether its last test run
  // failed, kept on the row because the log is not (a removed repo's logs are deleted). Older runs read as unknown.
  `ALTER TABLE runs ADD COLUMN run_end TEXT;
   ALTER TABLE runs ADD COLUMN last_test_failed INTEGER;`,
  // 35: escalation (domain/runs/escalate.ts). repos.escalate lets a retry after a failure a stronger model may fix run one
  // model up (on by default); the change is an `escalate` row in task_events.
  'ALTER TABLE repos ADD COLUMN escalate INTEGER NOT NULL DEFAULT 1;',
  // 36: the base commit a verify run read (domain/runs/verify.ts), so its findings can be marked stale once the base
  // moves on. NULL for every other kind.
  'ALTER TABLE runs ADD COLUMN base_commit TEXT;',
  `ALTER TABLE repos ADD COLUMN code_comment_max_lines INTEGER NOT NULL DEFAULT 5;
   ALTER TABLE repos ADD COLUMN code_comment_max_percent INTEGER NOT NULL DEFAULT 5;`,
];

export function migrate(db: DatabaseSync, steps: Migration[] = MIGRATIONS): number {
  const current = (): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (current() >= steps.length) return 0;
  db.exec('BEGIN IMMEDIATE');
  try {
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
