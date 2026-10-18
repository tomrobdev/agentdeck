import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, DEFAULTS, ensureDirs } from './config.ts';
import { BUDGET_KEYS, type Budget, DEFAULT_BUDGET } from './governor.ts';

export type TaskStatus =
  | 'proposed' // suggested by the planner, waiting for approval
  | 'queued'
  | 'running'
  | 'done'
  | 'blocked'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled';

export interface Repo {
  id: number;
  name: string;
  path: string;
  base_branch: string;
  test_cmd: string | null;
  allowed_tools: string | null; // JSON array, null = defaults
  auto_approve: number; // 1 = planner tasks skip approval
  planned_at: string | null;
}

export interface PlannerRun {
  id: number;
  repo_id: number;
  started_at: string;
  ended_at: string | null;
  outcome: string | null; // proposed | nothing | failed | rate_limited
  proposed: number;
  note: string | null;
  log_path: string;
}

export interface Task {
  id: number;
  repo_id: number;
  title: string;
  prompt: string;
  status: TaskStatus;
  priority: number;
  model: string;
  max_turns: number;
  attempts: number;
  max_attempts: number;
  branch: string | null;
  worktree: string | null;
  blocked_reason: string | null;
  source: string; // manual | planner
  created_at: string;
  updated_at: string;
}

export interface Run {
  id: number;
  task_id: number;
  attempt: number;
  started_at: string;
  ended_at: string | null;
  outcome: string | null; // done | blocked | failed | cancelled
  exit_code: number | null;
  session_id: string | null;
  num_turns: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  tests_passed: number | null; // 1, 0, or null when no test command
  result_text: string | null;
  log_path: string;
}

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

/** Columns added after the first release; CREATE TABLE IF NOT EXISTS won't add them to old databases. */
const ADDED_COLUMNS: [table: string, column: string, ddl: string][] = [
  ['repos', 'auto_approve', 'INTEGER NOT NULL DEFAULT 0'],
  ['repos', 'planned_at', 'TEXT'],
  ['tasks', 'source', "TEXT NOT NULL DEFAULT 'manual'"],
];

function migrate(db: DatabaseSync): void {
  for (const [table, column, ddl] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

export type Db = ReturnType<typeof openDb>;

export function openDb(path = DB_PATH) {
  if (path === DB_PATH) ensureDirs();
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);

  const now = "datetime('now')";

  return {
    raw: db,
    close: () => db.close(),

    // --- settings ---
    getSetting(key: string, fallback: string): string {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
      return row?.value ?? fallback;
    },
    setSetting(key: string, value: string): void {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    },
    isPaused(): boolean {
      // The daemon starts paused until someone explicitly resumes it.
      return this.getSetting('paused', '1') === '1';
    },
    budget(): Budget {
      return Object.fromEntries(BUDGET_KEYS.map((k) => [k, Number(this.getSetting(k, String(DEFAULT_BUDGET[k])))])) as unknown as Budget;
    },
    maxConcurrent(): number {
      return Number(this.getSetting('max_concurrent', String(DEFAULTS.maxConcurrent)));
    },

    // --- repos ---
    addRepo(r: { name: string; path: string; base_branch: string; test_cmd?: string | null; allowed_tools?: string[] | null }): Repo {
      const info = db
        .prepare('INSERT INTO repos (name, path, base_branch, test_cmd, allowed_tools) VALUES (?, ?, ?, ?, ?)')
        .run(r.name, r.path, r.base_branch, r.test_cmd ?? null, r.allowed_tools ? JSON.stringify(r.allowed_tools) : null);
      return this.getRepo(Number(info.lastInsertRowid))!;
    },
    getRepo(id: number): Repo | undefined {
      return db.prepare('SELECT * FROM repos WHERE id = ?').get(id) as Repo | undefined;
    },
    findRepo(nameOrId: string): Repo | undefined {
      return db.prepare('SELECT * FROM repos WHERE name = ? OR id = ?').get(nameOrId, Number(nameOrId) || -1) as Repo | undefined;
    },
    listRepos(): Repo[] {
      return db.prepare('SELECT * FROM repos ORDER BY name').all() as unknown as Repo[];
    },
    updateRepo(id: number, fields: Partial<Pick<Repo, 'auto_approve' | 'test_cmd' | 'planned_at'>>): void {
      const keys = Object.keys(fields) as (keyof typeof fields)[];
      if (!keys.length) return;
      db.prepare(`UPDATE repos SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
    },

    // --- planner ---
    tasksForRepo(repo_id: number, limit = 40): Task[] {
      return db.prepare('SELECT * FROM tasks WHERE repo_id = ? ORDER BY id DESC LIMIT ?').all(repo_id, limit) as unknown as Task[];
    },
    countOpen(repo_id: number): number {
      return (
        db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE repo_id = ? AND status IN ('queued', 'running', 'proposed', 'cancel_requested')").get(repo_id) as { n: number }
      ).n;
    },
    startPlannerRun(repo_id: number, log_path: string): number {
      db.prepare(`UPDATE repos SET planned_at = ${now} WHERE id = ?`).run(repo_id);
      return Number(db.prepare('INSERT INTO planner_runs (repo_id, log_path) VALUES (?, ?)').run(repo_id, log_path).lastInsertRowid);
    },
    finishPlannerRun(id: number, outcome: string, proposed: number, note: string | null): void {
      db.prepare(`UPDATE planner_runs SET ended_at = ${now}, outcome = ?, proposed = ?, note = ? WHERE id = ?`).run(outcome, proposed, note, id);
    },
    plannerRuns(repo_id?: number, limit = 10): PlannerRun[] {
      return (repo_id
        ? db.prepare('SELECT * FROM planner_runs WHERE repo_id = ? ORDER BY id DESC LIMIT ?').all(repo_id, limit)
        : db.prepare('SELECT * FROM planner_runs ORDER BY id DESC LIMIT ?').all(limit)) as unknown as PlannerRun[];
    },

    // --- tasks ---
    addTask(t: {
      repo_id: number;
      title: string;
      prompt: string;
      priority?: number;
      model?: string;
      max_turns?: number;
      max_attempts?: number;
      status?: 'queued' | 'proposed';
      source?: 'manual' | 'planner';
    }): Task {
      const info = db
        .prepare('INSERT INTO tasks (repo_id, title, prompt, priority, model, max_turns, max_attempts, status, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          t.repo_id,
          t.title,
          t.prompt,
          t.priority ?? 0,
          t.model ?? DEFAULTS.model,
          t.max_turns ?? DEFAULTS.maxTurns,
          t.max_attempts ?? DEFAULTS.maxAttempts,
          t.status ?? 'queued',
          t.source ?? 'manual',
        );
      return this.getTask(Number(info.lastInsertRowid))!;
    },
    getTask(id: number): Task | undefined {
      return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
    },
    listTasks(status?: TaskStatus): Task[] {
      return (status
        ? db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, id').all(status)
        : db.prepare('SELECT * FROM tasks ORDER BY id DESC').all()) as unknown as Task[];
    },
    countRunning(): number {
      return (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('running', 'cancel_requested')").get() as { n: number }).n;
    },
    /** Atomically claim the next queued task, or undefined if none. */
    claimNextTask(): Task | undefined {
      return db
        .prepare(
          `UPDATE tasks SET status = 'running', attempts = attempts + 1, updated_at = ${now}
           WHERE id = (SELECT id FROM tasks WHERE status = 'queued' ORDER BY priority DESC, id LIMIT 1)
           RETURNING *`,
        )
        .get() as Task | undefined;
    },
    updateTask(id: number, fields: Partial<Pick<Task, 'status' | 'branch' | 'worktree' | 'blocked_reason' | 'priority'>>): void {
      const keys = Object.keys(fields) as (keyof typeof fields)[];
      if (keys.length === 0) return;
      const sets = keys.map((k) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE tasks SET ${sets}, updated_at = ${now} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
    },
    /** Set status only if the task is currently in one of `from`. Returns true if it changed. */
    transitionTask(id: number, from: TaskStatus[], to: TaskStatus): boolean {
      const marks = from.map(() => '?').join(', ');
      const info = db.prepare(`UPDATE tasks SET status = ?, updated_at = ${now} WHERE id = ? AND status IN (${marks})`).run(to, id, ...from);
      return info.changes > 0;
    },
    /** After a crash, anything still marked running was orphaned: put it back in the queue. */
    recoverOrphans(): number {
      db.prepare(`UPDATE runs SET ended_at = ${now}, outcome = 'failed', result_text = 'daemon restarted' WHERE ended_at IS NULL`).run();
      db.prepare(`UPDATE tasks SET status = 'cancelled', updated_at = ${now} WHERE status = 'cancel_requested'`).run();
      db.prepare(`UPDATE planner_runs SET ended_at = ${now}, outcome = 'failed', note = 'daemon restarted' WHERE ended_at IS NULL`).run();
      const info = db.prepare(`UPDATE tasks SET status = 'queued', attempts = MAX(attempts - 1, 0), updated_at = ${now} WHERE status = 'running'`).run();
      return Number(info.changes);
    },

    // --- runs ---
    startRun(task_id: number, attempt: number, log_path: string): number {
      const info = db.prepare('INSERT INTO runs (task_id, attempt, log_path) VALUES (?, ?, ?)').run(task_id, attempt, log_path);
      return Number(info.lastInsertRowid);
    },
    finishRun(id: number, r: Partial<Omit<Run, 'id' | 'task_id' | 'attempt' | 'started_at' | 'log_path'>>): void {
      const keys = Object.keys(r) as (keyof typeof r)[];
      const sets = keys.map((k) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE runs SET ${sets}${keys.length ? ', ' : ''}ended_at = ${now} WHERE id = ?`).run(...keys.map((k) => r[k] ?? null), id);
    },
    runsForTask(task_id: number): Run[] {
      return db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY id').all(task_id) as unknown as Run[];
    },

    // --- notifications ---
    addNotification(kind: string, title: string, body: string, task_id: number | null): void {
      db.prepare('INSERT INTO notifications (kind, title, body, task_id) VALUES (?, ?, ?, ?)').run(kind, title, body, task_id);
      db.prepare('DELETE FROM notifications WHERE id <= (SELECT MAX(id) - 200 FROM notifications)').run();
    },
    recentNotifications(limit = 20): { id: number; kind: string; title: string; body: string; task_id: number | null; created_at: string }[] {
      return db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT ?').all(limit) as never;
    },

    // --- usage ---
    recordUsageWindow(window: string, utilization: number, resets_at: number, status: string | null): void {
      db.prepare(
        `INSERT INTO usage_windows (window, utilization, resets_at, status, observed_at) VALUES (?, ?, ?, ?, ${now})
         ON CONFLICT(window) DO UPDATE SET utilization = excluded.utilization, resets_at = excluded.resets_at,
           status = excluded.status, observed_at = excluded.observed_at`,
      ).run(window, utilization, resets_at, status);
    },
    usageWindows(): { window: string; utilization: number; resets_at: number; status: string | null; observed_at: string }[] {
      return db.prepare('SELECT * FROM usage_windows ORDER BY window').all() as never;
    },
  };
}
