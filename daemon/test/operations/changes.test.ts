// The change watcher: real SQLite, a second connection standing in for the CLI.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { waitFor } from '#test/fixtures/fixtures.ts';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-changes-'));
process.env.AGENTDECK_HOME = home;

const { openDb } = await import('#db/index.ts');
const { ChangeWatcher } = await import('#application/operations/changes.ts');

const file = join(home, 'test.db');
const db = openDb(file);
const other = new DatabaseSync(file);
other.exec('PRAGMA busy_timeout = 5000');
const watcher = new ChangeWatcher(db);

after(() => {
  watcher.stop();
  other.close();
  db.close();
});

test('a write from another connection moves rev and calls onOtherProcess', () => {
  let woken = 0;
  const seen: number[] = [];
  watcher.onOtherProcess(() => woken++);
  const off = watcher.subscribe((rev) => seen.push(rev));
  const before = watcher.rev;
  other.exec("INSERT INTO settings (key, value) VALUES ('from_cli', '1') ON CONFLICT (key) DO UPDATE SET value = value || '1'");
  watcher.check();
  assert.equal(watcher.rev, before + 1);
  assert.deepEqual(seen, [before + 1]);
  assert.equal(woken, 1);
  off();
});

test('a write through the daemon’s own Db moves rev but does not call onOtherProcess', () => {
  let woken = 0;
  watcher.onOtherProcess(() => woken++);
  const before = watcher.rev;
  db.setPaused(true);
  watcher.check();
  assert.equal(watcher.rev, before + 1);
  assert.equal(woken, 0);
});

test('with no writes, rev stays put across several intervals', async () => {
  const live = new ChangeWatcher(db);
  live.start(5);
  const before = live.rev;
  await sleep(60);
  live.stop();
  assert.equal(live.rev, before);
});

test('the timer notices a write on its own', async () => {
  const live = new ChangeWatcher(db);
  live.start(5);
  const before = live.rev;
  db.setPaused(false);
  try {
    await waitFor(() => live.rev > before, { what: 'the timer to move rev' });
  } finally {
    live.stop();
  }
  assert.ok(live.rev > before);
});
