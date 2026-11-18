// Retrying with a turn limit: it is set in the retry's own guarded write, before the task can be claimed.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-retry-turns-'));
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('#test/fixtures/open-db.ts');
const { cancelledTask, failedTask, testApp } = await import('#test/fixtures/fixtures.ts');
const { retryTask, ActionError } = await import('#application/actions.ts');

function setup() {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  return { db, repo, app: testApp(db) };
}

test('a retry with max_turns from failed sets it, and the first claim sees it', () => {
  const { db, repo, app } = setup();
  const t = failedTask(db, repo, { max_turns: 40 });
  retryTask(app, t.id, { max_turns: 80 });
  const claimed = db.applyEvent(t.id, { type: 'claim' });
  assert.equal(claimed?.task.max_turns, 80);
});

test('a retry with max_turns from cancelled sets it before the task can be claimed', () => {
  const { db, repo, app } = setup();
  const t = cancelledTask(db, repo, { max_turns: 40 });
  retryTask(app, t.id, { max_turns: 120 });
  const task = db.getTask(t.id);
  assert.equal(task?.status, 'queued');
  assert.equal(task?.max_turns, 120);
});

test('a retry refuses a bad max_turns and leaves the task as it was', () => {
  const { db, repo, app } = setup();
  const t = failedTask(db, repo, { max_turns: 40 });
  assert.throws(() => retryTask(app, t.id, { max_turns: 0 }), ActionError);
  assert.throws(() => retryTask(app, t.id, { max_turns: 1.5 }), ActionError);
  assert.equal(db.getTask(t.id)?.status, 'failed');
  assert.equal(db.getTask(t.id)?.max_turns, 40);
});

test('a retry from a status it does not cover does not change max_turns', () => {
  const { db, repo, app } = setup();
  const t = db.addTask({ repo_id: repo.id, title: 't', prompt: 'p', max_turns: 40 });
  assert.throws(() => retryTask(app, t.id, { max_turns: 90 }), ActionError);
  assert.equal(db.getTask(t.id)?.max_turns, 40);
});
