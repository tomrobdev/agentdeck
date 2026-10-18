import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, DEFAULTS, ensureDirs } from './config.ts';
import { BUDGET_KEYS, type Budget, DEFAULT_BUDGET } from './governor.ts';

import { type TaskEvent, type TaskStatus, fromStatuses, nextStatus } from './domain/task-lifecycle.ts';

export type { TaskStatus };

export interface Repo {
  id: number;
  name: string;
  path: string;
  base_branch: string;
  test_cmd: string | null;
  allowed_tools: string | null; // JSON array, null = generic defaults plus the toolchain's rules
  auto_approve: number; // 1 = planner tasks skip approval
  planned_at: string | null;
  toolchain: string | null; // pnpm | yarn | npm | cargo | uv | go, null = not detected
  setup_cmd: string | null; // run in each worktree before claude
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
  restarts: number; // times a daemon restart requeued this task mid-run
  created_at: string;
  updated_at: string;
}

export type TaskSummary = Omit<Task, 'prompt'>;

const SUMMARY_COLUMNS =
  'id, repo_id, title, status, priority, model, max_turns, attempts, max_attempts, branch, worktree, blocked_reason, source, restarts, created_at, updated_at';

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
  pid: number | null; // claude's process group while the run is live
}

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

/** A task requeued by this many daemon restarts is failed instead, in case the task itself kills the daemon. */
export const MAX_RESTARTS = 3;

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

export type Db = ReturnType<typeof openDb>;

export function openDb(path = DB_PATH) {
  if (path === DB_PATH) ensureDirs();
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
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
    addRepo(r: {
      name: string;
      path: string;
      base_branch: string;
      test_cmd?: string | null;
      allowed_tools?: string[] | null;
      toolchain?: string | null;
      setup_cmd?: string | null;
    }): Repo {
      const info = db
        .prepare('INSERT INTO repos (name, path, base_branch, test_cmd, allowed_tools, toolchain, setup_cmd) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(
          r.name,
          r.path,
          r.base_branch,
          r.test_cmd ?? null,
          r.allowed_tools ? JSON.stringify(r.allowed_tools) : null,
          r.toolchain ?? null,
          r.setup_cmd ?? null,
        );
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
    updateRepo(id: number, fields: Partial<Pick<Repo, 'auto_approve' | 'test_cmd' | 'setup_cmd' | 'planned_at' | 'base_branch'>>): void {
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
        db
          .prepare("SELECT COUNT(*) AS n FROM tasks WHERE repo_id = ? AND status IN ('queued', 'running', 'proposed', 'cancel_requested')")
          .get(repo_id) as { n: number }
      ).n;
    },
    startPlannerRun(repo_id: number, log_path: string): number {
      db.prepare(`UPDATE repos SET planned_at = ${now} WHERE id = ?`).run(repo_id);
      return Number(db.prepare('INSERT INTO planner_runs (repo_id, log_path) VALUES (?, ?)').run(repo_id, log_path).lastInsertRowid);
    },
    finishPlannerRun(id: number, outcome: string, proposed: number, note: string | null): void {
      db.prepare(`UPDATE planner_runs SET ended_at = ${now}, outcome = ?, proposed = ?, note = ? WHERE id = ?`).run(
        outcome,
        proposed,
        note,
        id,
      );
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
        .prepare(
          'INSERT INTO tasks (repo_id, title, prompt, priority, model, max_turns, max_attempts, status, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
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
    hasQueued(): boolean {
      const row = db.prepare("SELECT EXISTS(SELECT 1 FROM tasks WHERE status = 'queued') AS q").get() as { q: number };
      return row.q === 1;
    },
    /**
     * Tasks without their prompt, newest first. Returns the `limit` newest tasks older than `before`
     * (all tasks when omitted). On the first page (no `before`) every active task is included on top
     * of the limit, so views of in-flight work stay complete. Later pages hold older tasks only.
     */
    listTaskSummaries(opts: { status?: TaskStatus; limit: number; before?: number }): TaskSummary[] {
      const { status = null, limit, before = null } = opts;
      return db
        .prepare(
          `SELECT ${SUMMARY_COLUMNS} FROM tasks
           WHERE (? IS NULL OR status = ?)
             AND (id IN (SELECT id FROM tasks WHERE (? IS NULL OR status = ?) AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?)
                  OR (? IS NULL AND status IN ('proposed', 'queued', 'running', 'cancel_requested')))
           ORDER BY id DESC`,
        )
        .all(status, status, status, status, before, before, limit, before) as unknown as TaskSummary[];
    },
    countRunning(): number {
      return (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('running', 'cancel_requested')").get() as { n: number }).n;
    },
    /** Atomically claim the next queued task, or undefined if none. */
    claimNextTask(): Task | undefined {
      const from = fromStatuses({ type: 'claim' });
      const marks = from.map(() => '?').join(', ');
      return db
        .prepare(
          `UPDATE tasks SET status = ?, attempts = attempts + 1, updated_at = ${now}
           WHERE status IN (${marks})
             AND id = (SELECT id FROM tasks WHERE status IN (${marks}) ORDER BY priority DESC, id LIMIT 1)
           RETURNING *`,
        )
        .get(nextStatus(from[0], { type: 'claim' })!, ...from, ...from) as Task | undefined;
    },
    updateTask(id: number, fields: Partial<Pick<Task, 'branch' | 'worktree' | 'blocked_reason' | 'priority'>>): void {
      const keys = Object.keys(fields) as (keyof typeof fields)[];
      if (keys.length === 0) return;
      const sets = keys.map((k) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE tasks SET ${sets}, updated_at = ${now} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
    },
    /**
     * The only way to change a task's status. Asks the lifecycle whether `event` is allowed from the
     * task's current status and writes the result guarded by that status, so a concurrent change
     * (say, a cancel arriving as a run finishes) is never overwritten. Returns the updated task, or
     * undefined if the task is missing or the event isn't allowed.
     */
    applyEvent(id: number, event: TaskEvent, opts: { reason?: string | null } = {}): Task | undefined {
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = this.getTask(id);
        if (!cur) return undefined;
        const to = nextStatus(cur.status, event);
        if (!to) return undefined;
        const sets = ['status = ?'];
        const params: (string | number | null)[] = [to];
        if (to !== 'cancelled') {
          const give = 'attempts = MAX(attempts - 1, 0)';
          if (event.type === 'claim') sets.push('attempts = attempts + 1');
          else if (event.type === 'retry')
            sets.push('max_attempts = attempts + 1'); // one more attempt on top of those used
          else if (event.type === 'rate_limited') sets.push(give);
          else if (event.type === 'recover') sets.push('restarts = restarts + 1', ...(to === 'queued' ? [give] : []));
          if (event.type === 'finish' && event.outcome === 'done') sets.push('blocked_reason = NULL');
          if (
            (event.type === 'finish' && (event.outcome === 'blocked' || event.outcome === 'failed')) ||
            (event.type === 'recover' && to === 'failed')
          ) {
            sets.push('blocked_reason = ?');
            params.push(opts.reason ?? null);
          }
        }
        const row = db
          .prepare(`UPDATE tasks SET ${sets.join(', ')}, updated_at = ${now} WHERE id = ? AND status IN (?) RETURNING *`)
          .get(...params, id, cur.status) as Task | undefined;
        if (row) return row;
      }
      return undefined;
    },
    /** Claude processes recorded on runs that never finished: a previous daemon died mid-run. */
    unfinishedPids(): { pid: number; started_at: string }[] {
      return db
        .prepare(
          `SELECT pid, started_at FROM runs WHERE ended_at IS NULL AND pid IS NOT NULL
           UNION ALL SELECT pid, started_at FROM planner_runs WHERE ended_at IS NULL AND pid IS NOT NULL`,
        )
        .all() as never;
    },
    /**
     * After a crash, anything still marked running was orphaned: put it back in the queue,
     * unless restarts keep interrupting it. Stop its claude process (`reapOrphans`) first.
     */
    recoverOrphans(): { requeued: number; failed: number } {
      db.prepare(`UPDATE runs SET ended_at = ${now}, outcome = 'failed', result_text = 'daemon restarted' WHERE ended_at IS NULL`).run();
      db.prepare(`UPDATE planner_runs SET ended_at = ${now}, outcome = 'failed', note = 'daemon restarted' WHERE ended_at IS NULL`).run();
      let requeued = 0;
      let failed = 0;
      const orphans = db.prepare("SELECT id, restarts FROM tasks WHERE status IN ('running', 'cancel_requested')").all() as {
        id: number;
        restarts: number;
      }[];
      for (const o of orphans) {
        const exhausted = o.restarts + 1 >= MAX_RESTARTS;
        const reason = `the daemon restarted ${o.restarts + 1} times while this task was running`;
        const t = this.applyEvent(o.id, { type: 'recover', exhausted }, { reason });
        if (t?.status === 'queued') requeued++;
        else if (t?.status === 'failed') failed++;
      }
      return { requeued, failed };
    },

    // --- runs ---
    startRun(task_id: number, attempt: number, log_path: string): number {
      const info = db.prepare('INSERT INTO runs (task_id, attempt, log_path) VALUES (?, ?, ?)').run(task_id, attempt, log_path);
      return Number(info.lastInsertRowid);
    },
    setRunPid(id: number, pid: number): void {
      db.prepare('UPDATE runs SET pid = ? WHERE id = ?').run(pid, id);
    },
    setPlannerRunPid(id: number, pid: number): void {
      db.prepare('UPDATE planner_runs SET pid = ? WHERE id = ?').run(pid, id);
    },
    finishRun(id: number, r: Partial<Omit<Run, 'id' | 'task_id' | 'attempt' | 'started_at' | 'log_path'>>): void {
      const keys = Object.keys(r) as (keyof typeof r)[];
      const sets = keys.map((k) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE runs SET ${sets}${keys.length ? ', ' : ''}ended_at = ${now} WHERE id = ?`).run(
        ...keys.map((k) => r[k] ?? null),
        id,
      );
    },
    runsForTask(task_id: number): Run[] {
      return db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY id').all(task_id) as unknown as Run[];
    },

    // --- notifications ---
    addNotification(kind: string, title: string, body: string, task_id: number | null): void {
      db.prepare('INSERT INTO notifications (kind, title, body, task_id) VALUES (?, ?, ?, ?)').run(kind, title, body, task_id);
      db.prepare('DELETE FROM notifications WHERE id <= (SELECT MAX(id) - 200 FROM notifications)').run();
    },
    recentNotifications(
      limit = 20,
    ): { id: number; kind: string; title: string; body: string; task_id: number | null; created_at: string }[] {
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
