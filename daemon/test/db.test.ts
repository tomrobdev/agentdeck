import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.ts';

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
  const { MIGRATIONS, migrate } = await import('../src/db.ts');
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
