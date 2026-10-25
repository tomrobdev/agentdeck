// Slots are counted from the db: running tasks, open resolve runs and planner runs, each slot once.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-slots-'));
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('../src/db/index.ts');
const { startWaits } = await import('../src/application/scheduler/queue.ts');
const { canStartResolve } = await import('../src/application/sync.ts');

function setup() {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  db.setPaused(false);
  db.setSetting('max_concurrent', '2');
  const task = (title: string) => db.addTask({ repo_id: repo.id, title, prompt: 'p' });
  return { db, repo, task };
}

test('a running task and an open resolve run fill two slots: nothing else is claimed', () => {
  const { db, task } = setup();
  const running = task('running');
  const done = task('done');
  assert.ok(db.applyEvent(done.id, { type: 'claim' }));
  assert.ok(db.applyEvent(done.id, { type: 'finish', outcome: 'done' }));
  const queued = task('queued');
  assert.ok(db.applyEvent(running.id, { type: 'claim' }));
  db.startRun(done.id, 0, '/tmp/resolve.log', 'resolve');

  assert.equal(db.slotsUsed(), 2);
  assert.equal(canStartResolve(db), false);
  assert.deepEqual(startWaits(db)(db.getTask(queued.id)!), { kind: 'slots', running: 2, max: 2 });
  db.close();
});

test('a running task whose sync started a resolve run counts once', () => {
  const { db, task } = setup();
  const t = task('t');
  assert.ok(db.applyEvent(t.id, { type: 'claim' }));
  db.startRun(t.id, 1, '/tmp/a.log', 'resolve');
  assert.equal(db.slotsUsed(), 1);
  db.close();
});

test('a finished resolve run frees its slot, and a planner run takes one', () => {
  const { db, repo, task } = setup();
  const t = task('t');
  const run = db.startRun(t.id, 0, '/tmp/a.log', 'resolve');
  assert.equal(db.slotsUsed(), 1);
  db.finishRun(run, {});
  assert.equal(db.slotsUsed(), 0);
  db.startPlannerRun(repo.id, '/tmp/p.log');
  assert.equal(db.slotsUsed(), 1);
  db.close();
});

test('the resolve-run half of slotsUsed looks tasks up through the runs_task index', () => {
  const { db } = setup();
  try {
    const plan = db.raw
      .prepare(
        `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM tasks t WHERE t.status NOT IN ('running', 'cancel_requested')
           AND EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND r.kind = 'resolve' AND r.ended_at IS NULL)`,
      )
      .all() as { detail: string }[];
    assert.match(plan.map((p) => p.detail).join('\n'), /USING (COVERING )?INDEX runs_task/);
  } finally {
    db.close();
  }
});
