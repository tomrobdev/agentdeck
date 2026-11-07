import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MIGRATIONS, migrate, openDb } from '../src/db/index.ts';
import { asTaskId } from '../src/domain/shared/id.ts';
import { stopReasonOf } from '../src/domain/work/task.ts';

function tmpPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-mig-'));
  return { path: join(dir, 'db.sqlite'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const version = (db: DatabaseSync) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

function tableInfo(db: DatabaseSync): Record<string, unknown[]> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {
    name: string;
  }[];
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`PRAGMA table_info(${name})`).all()]));
}

// The first-release schema: no auto_approve/planned_at/source/restarts/pid columns.
const OLD_SCHEMA = `
CREATE TABLE repos (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL UNIQUE,
  base_branch TEXT NOT NULL DEFAULT 'main',
  test_cmd TEXT,
  allowed_tools TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE tasks (
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
CREATE INDEX tasks_pick ON tasks(status, priority DESC, id);
CREATE TABLE runs (
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
CREATE TABLE usage_windows (
  window TEXT PRIMARY KEY,
  utilization REAL NOT NULL,
  resets_at INTEGER NOT NULL,
  status TEXT,
  observed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE planner_runs (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  outcome TEXT,
  proposed INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  log_path TEXT NOT NULL
);
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  task_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

test('a database from an earlier release upgrades to the fresh schema', () => {
  const old = tmpPath();
  const fresh = tmpPath();
  try {
    const legacy = new DatabaseSync(old.path);
    legacy.exec(OLD_SCHEMA);
    // An in-between release that already had some of the added columns.
    legacy.exec('ALTER TABLE repos ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0');
    legacy.exec("INSERT INTO repos (name, path) VALUES ('r', '/r')");
    legacy.close();

    const upgraded = openDb(old.path);
    const reference = openDb(fresh.path);
    try {
      assert.deepEqual(tableInfo(upgraded.raw), tableInfo(reference.raw));
      assert.equal(version(upgraded.raw), MIGRATIONS.length);
      assert.equal((upgraded.raw.prepare('SELECT count(*) AS n FROM repos').get() as { n: number }).n, 1);
    } finally {
      upgraded.close();
      reference.close();
    }
  } finally {
    old.cleanup();
    fresh.cleanup();
  }
});

test('a stored blocked_reason survives as stop_reason', () => {
  const t = tmpPath();
  try {
    const legacy = new DatabaseSync(t.path);
    legacy.exec(OLD_SCHEMA);
    legacy.exec("INSERT INTO repos (name, path) VALUES ('r', '/r')");
    legacy.exec(
      "INSERT INTO tasks (repo_id, title, prompt, status, model, max_turns, max_attempts, blocked_reason) VALUES (1, 't', 'p', 'blocked', 'm', 5, 2, 'which database?')",
    );
    legacy.close();

    const db = openDb(t.path);
    try {
      assert.equal(stopReasonOf(db.getTask(asTaskId(1))!), 'which database?');
    } finally {
      db.close();
    }
  } finally {
    t.cleanup();
  }
});

test('a stored notify_events with hold gains paused; one without hold is unchanged', () => {
  const upgraded = (value: string): string | undefined => {
    const t = tmpPath();
    try {
      const legacy = new DatabaseSync(t.path);
      legacy.exec(OLD_SCHEMA);
      legacy.prepare("INSERT INTO settings (key, value) VALUES ('notify_events', ?)").run(value);
      legacy.close();
      const db = openDb(t.path);
      try {
        return (db.raw.prepare("SELECT value FROM settings WHERE key = 'notify_events'").get() as { value: string } | undefined)?.value;
      } finally {
        db.close();
      }
    } finally {
      t.cleanup();
    }
  };
  assert.equal(upgraded('done,hold'), 'done,hold,paused');
  assert.equal(upgraded('done,blocked'), 'done,blocked');
  assert.equal(upgraded('hold,paused'), 'hold,paused');
});

test('opening an up-to-date database runs no steps', () => {
  const t = tmpPath();
  try {
    openDb(t.path).close();
    const db = new DatabaseSync(t.path);
    try {
      let ran = 0;
      const counting = MIGRATIONS.map((step) => () => {
        ran++;
        if (typeof step === 'string') db.exec(step);
        else step(db);
      });
      assert.equal(migrate(db, counting), 0);
      assert.equal(ran, 0);
    } finally {
      db.close();
    }
    openDb(t.path).close(); // real second open still works
  } finally {
    t.cleanup();
  }
});

test('a failing step rolls back and leaves user_version unchanged', () => {
  const t = tmpPath();
  try {
    const db = new DatabaseSync(t.path);
    try {
      const steps = [
        'CREATE TABLE one (id INTEGER)',
        (d: DatabaseSync) => {
          d.exec('CREATE TABLE two (id INTEGER)');
          throw new Error('boom');
        },
      ];
      assert.throws(() => migrate(db, steps), /boom/);
      assert.equal(version(db), 0);
      assert.deepEqual(tableInfo(db), {});

      // A later, fixed attempt succeeds from scratch.
      assert.equal(migrate(db, [steps[0], 'CREATE TABLE two (id INTEGER)']), 2);
      assert.equal(version(db), 2);
    } finally {
      db.close();
    }
  } finally {
    t.cleanup();
  }
});
