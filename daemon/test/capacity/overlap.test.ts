import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-overlap-'));
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('#test/fixtures/open-db.ts');
const { startWaits } = await import('#application/capacity/queue.ts');
const { claimNext } = await import('#application/capacity/overlap.ts');
const { NOT_DRAINING } = await import('#domain/capacity/index.ts');

function setup() {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  db.setPaused(false);
  db.setSetting('max_concurrent', '4');
  db.updateRepo(repo.id, { max_concurrent: 2 });
  const task = (prompt: string) => db.addTask({ repo_id: repo.id, title: 't', prompt });
  return { db, repo, task };
}

test('repo at 2 slots, three queued tasks where the first two overlap: the first and third start, the second waits for the first', () => {
  const { db, task } = setup();
  const first = task('Change `daemon/src/a.ts`.');
  const second = task('Look in `daemon/src/` and fix it.');
  const third = task('Change `daemon/src/b.ts`.');
  assert.equal(claimNext(db, NOT_DRAINING)?.id, first.id);
  assert.equal(claimNext(db, NOT_DRAINING)?.id, third.id);
  assert.equal(claimNext(db, NOT_DRAINING), undefined);
  assert.deepEqual(startWaits(db)(db.getTask(second.id)!, { kind: 'none' }), { kind: 'overlap', with: first.id });
  assert.ok(db.applyEvent(first.id, { type: 'finish', outcome: 'done' }));
  assert.ok(db.applyEvent(third.id, { type: 'finish', outcome: 'done' }));
  assert.equal(claimNext(db, NOT_DRAINING)?.id, second.id);
  db.close();
});

test("a retry's footprint takes the files its last work run's branch changed", () => {
  const { db, task } = setup();
  const running = task('Change `daemon/src/a.ts`.');
  const retry = task('No paths named.');
  const run = db.startRun(retry.id, 1, '/tmp/w.log', 'work');
  db.finishRun(run, { outcome: 'failed', changed_paths: ['daemon/src/a.ts'] });
  assert.equal(db.runsForTask(retry.id)[0]?.changed_paths?.[0], 'daemon/src/a.ts');
  assert.equal(claimNext(db, NOT_DRAINING)?.id, running.id);
  assert.deepEqual(startWaits(db)(db.getTask(retry.id)!, { kind: 'none' }), { kind: 'overlap', with: running.id });
  assert.equal(claimNext(db, NOT_DRAINING), undefined);
  db.close();
});

test('an empty footprint overlaps nothing: a task naming no paths starts beside a running one', () => {
  const { db, task } = setup();
  const a = task('Change `daemon/src/a.ts`.');
  const b = task('Tidy up.');
  assert.deepEqual([claimNext(db, NOT_DRAINING)?.id, claimNext(db, NOT_DRAINING)?.id], [a.id, b.id]);
  db.close();
});
