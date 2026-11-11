// Moving a task's PR and merge request through the store: an allowed move is written, one the table doesn't allow is logged and never written.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-prmoves-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('../../../src/db/index.ts');
const { doneTask, testApp } = await import('../../fixtures/fixtures.ts');
const { endMergeRequest, movePr } = await import('../../../src/application/landing/moves.ts');
const { cancelMergeRequest, requestMerge } = await import('../../../src/application/actions.ts');

const db = testApp(openDb(join(home, 'test.db')));
after(() => db.close());
const repo = db.addRepo({ name: 'demo', path: home, base_branch: 'main', test_cmd: 'true' });

let n = 0;
const openTask = () => doneTask(db, repo, { pr: 'open', url: `https://x/pull/${++n}` });

test('a PR move the table allows is written, and returns the state it moved to', () => {
  const t = openTask();
  const logs: string[] = [];
  assert.equal(
    movePr(db, t, { type: 'seen', state: 'merged' }, (m) => logs.push(m)),
    'merged',
  );
  assert.equal(db.getTask(t.id)!.pr?.state, 'merged');
  assert.deepEqual(logs, []);
});

test('a PR move the table does not allow is logged and never written', () => {
  const t = openTask();
  const before = db.eventsForTask(t.id).length;
  const logs: string[] = [];
  assert.equal(
    movePr(db, t, { type: 'opened', url: 'https://x/pull/other' }, (m) => logs.push(m)),
    null,
  );
  assert.deepEqual(logs, [`task ${t.id}: PR move opened from open is not in the table, ignored`]);
  assert.equal(db.getTask(t.id)!.pr?.url, t.pr?.url);
  assert.equal(db.eventsForTask(t.id).length, before, 'no event is recorded');
  assert.equal(
    movePr(db, t, { type: 'seen', state: 'open' }, () => {}),
    null,
    'a PR seen open again is ignored',
  );
  assert.equal(db.recordPr(t.id, { type: 'seen', state: 'open' }), false, 'the store refuses it too');
});

test('a merge request moves by its table: asked, then dropped, and a second drop is logged and ignored', () => {
  const t = openTask();
  requestMerge(db, t.id);
  const asked = db.getTask(t.id)!;
  assert.ok(asked.pr?.merge_request);
  const logs: string[] = [];
  assert.equal(
    endMergeRequest(db, asked, 'refused', (m) => logs.push(m)),
    true,
  );
  assert.equal(db.getTask(t.id)!.pr?.merge_request, null);
  assert.equal(
    endMergeRequest(db, db.getTask(t.id)!, 'dropped', (m) => logs.push(m)),
    false,
  );
  assert.deepEqual(logs, [`task ${t.id}: merge request move dropped from none is not in the table, ignored`]);
  assert.deepEqual(cancelMergeRequest(db, t.id), { cancelled: false });
});
