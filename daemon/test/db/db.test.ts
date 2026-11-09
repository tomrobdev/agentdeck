// Database helpers: real SQLite.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-db-'));
process.env.AGENTDECK_HOME = home;

const { openDb } = await import('../../src/db/index.ts');
const db = openDb(join(home, 'test.db'));

after(() => db.close());

test('hasQueued is true only while a queued task exists', () => {
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  assert.equal(db.hasQueued(), false);

  const proposed = db.addTask({ repo_id: repo.id, title: 'p', prompt: 'p', status: 'proposed' });
  assert.equal(db.hasQueued(), false);

  const queued = db.addTask({ repo_id: repo.id, title: 'q', prompt: 'q' });
  assert.equal(db.hasQueued(), true);

  assert.equal(db.claimNextTask()?.id, queued.id);
  assert.equal(db.hasQueued(), false);

  assert.ok(db.applyEvent(proposed.id, { type: 'approve' }));
  assert.equal(db.hasQueued(), true);
});
test('latestRunModels gives each task the model of its latest work run', () => {
  const db = openDb(':memory:');
  try {
    const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
    const a = db.addTask({ repo_id: repo.id, title: 'a', prompt: 'a' });
    const b = db.addTask({ repo_id: repo.id, title: 'b', prompt: 'b' });
    db.addTask({ repo_id: repo.id, title: 'none', prompt: 'n' });
    db.startRun(a.id, 1, '/tmp/a1.log', 'work', 'sonnet');
    db.startRun(a.id, 2, '/tmp/a2.log', 'work', 'opus');
    db.startRun(a.id, 2, '/tmp/a3.log', 'resolve', 'haiku'); // a resolve run is not the task's model
    db.startRun(b.id, 1, '/tmp/b1.log', 'work', null); // from before runs recorded it
    const models = db.latestRunModels();
    assert.equal(models.get(a.id), 'opus');
    assert.equal(models.has(b.id), false);
    assert.equal(models.size, 1);
  } finally {
    db.close();
  }
});
test('runsForTask query uses the runs_task index', () => {
  const db = openDb(':memory:');
  try {
    const plan = db.raw.prepare('EXPLAIN QUERY PLAN SELECT * FROM runs WHERE task_id = ? ORDER BY id').all(1) as {
      detail: string;
    }[];
    const details = plan.map((p) => p.detail).join('\n');
    assert.match(details, /USING (COVERING )?INDEX runs_task/);
    assert.doesNotMatch(details, /SCAN runs/);
  } finally {
    db.close();
  }
});

test('a database already at version 1 gets the runs_task index on open', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { MIGRATIONS, migrate } = await import('../../src/db/index.ts');
  const path = join(mkdtempSync(join(tmpdir(), 'agentdeck-db-')), 'v1.db');
  const v1 = new DatabaseSync(path);
  migrate(v1, MIGRATIONS.slice(0, 1));
  v1.close();

  const db = openDb(path);
  try {
    const index = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'runs_task'").get();
    assert.ok(index, 'runs_task index created by migration step 2');
  } finally {
    db.close();
  }
});

test('atomically: processes that read and then write at once all land, waiting on the lock instead of failing', async () => {
  const { spawn } = await import('node:child_process');
  const path = join(home, 'concurrent.db');
  openDb(path).close();
  const child = `
    const { openDb } = await import(${JSON.stringify(join(import.meta.dirname, '../../src/db/index.ts'))});
    const { atomically } = await import(${JSON.stringify(join(import.meta.dirname, '../../src/db/sql.ts'))});
    const db = openDb(process.env.DB);
    for (let i = 0; i < 100; i++)
      atomically(db.raw, () => {
        const n = db.raw.prepare("SELECT count(*) AS n FROM settings").get().n;
        db.raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run('k' + (i % 3), String(n));
      });
    db.close();
  `;
  const codes = await Promise.all(
    Array.from(
      { length: 8 },
      () =>
        new Promise<string>((resolve) => {
          const p = spawn(process.execPath, ['--input-type=module', '-e', child], { env: { ...process.env, DB: path } });
          let err = '';
          p.stderr.on('data', (b) => (err += b));
          p.on('exit', (code) => resolve(code === 0 ? 'ok' : err));
        }),
    ),
  );
  assert.deepEqual(codes, Array(8).fill('ok'));
});

test('atomically: inside a transaction it is a savepoint, so a failure rolls back only its own writes', async () => {
  const { atomically } = await import('../../src/db/sql.ts');
  const keys = () =>
    (db.raw.prepare("SELECT key FROM settings WHERE key IN ('outer', 'inner')").all() as { key: string }[]).map((r) => r.key);
  db.raw.exec('BEGIN');
  db.setSetting('outer', '1');
  assert.throws(() =>
    atomically(db.raw, () => {
      db.setSetting('inner', '1');
      throw new Error('no');
    }),
  );
  db.raw.exec('COMMIT');
  assert.deepEqual(keys(), ['outer']);
});
