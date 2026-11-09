// A done task with a sync under way carries its sync view on the task summaries, whoever started the sync.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-syncview-'));
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('../../fixtures/open-db.ts');
const { taskViews } = await import('../../../src/application/actions.ts');
const { doneTask } = await import('../../fixtures/fixtures.ts');

test('taskViews gives a done task with an unfinished resolve run its sync view, and the others none', () => {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  const syncing = doneTask(db, repo, { title: 'syncing', pr: 'open' });
  const idle = doneTask(db, repo, { title: 'idle', pr: 'open' });
  const ended = doneTask(db, repo, { title: 'ended', pr: 'open' });

  const run = db.startRun(syncing.id, 0, '/tmp/a.log', 'resolve');
  db.setRunLive(run, 4, 'Edit a.ts');
  db.finishRun(db.startRun(ended.id, 0, '/tmp/b.log', 'resolve'), {});

  const views = new Map(taskViews(db, { limit: 50 }).map((t) => [t.id, t.sync]));
  assert.deepEqual(views.get(syncing.id), {
    base: 'main',
    since: db.runsForTask(syncing.id)[0].started_at,
    resolving: true,
    turns: 4,
    max_turns: db.getTask(syncing.id)!.max_turns,
    tool: 'Edit a.ts',
  });
  assert.equal(views.get(idle.id), null);
  assert.equal(views.get(ended.id), null, 'a finished resolve run is not a sync under way');
  db.close();
});
