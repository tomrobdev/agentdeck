// Slots are counted from the db: running tasks, open resolve runs and planner runs, each slot once.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-slots-'));
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('#test/fixtures/open-db.ts');
const { startWaits } = await import('#application/capacity/queue.ts');
const { canStartResolve } = await import('#application/runs/sync.ts');
const { updateRepo } = await import('#application/actions.ts');
const { repoSettingPatch } = await import('#cli/operations/settings-args.ts');

function setup() {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  db.setPaused(false);
  db.setSetting('max_concurrent', '2');
  const task = (title: string) => db.addTask({ repo_id: repo.id, title, prompt: 'p' });
  return { db, repo, task };
}

test('a running task and an open resolve run fill two slots: nothing else is claimed', () => {
  const { db, repo, task } = setup();
  db.updateRepo(repo.id, { max_concurrent: 2 });
  const running = task('running');
  const done = task('done');
  assert.ok(db.applyEvent(done.id, { type: 'claim' }));
  assert.ok(db.applyEvent(done.id, { type: 'finish', outcome: 'done' }));
  const queued = task('queued');
  assert.ok(db.applyEvent(running.id, { type: 'claim' }));
  db.startRun(done.id, 0, '/tmp/resolve.log', 'resolve');

  assert.equal(db.slotsUsed(), 2);
  assert.equal(canStartResolve(db), false);
  assert.deepEqual(startWaits(db)(db.getTask(queued.id)!, { kind: 'none' }), { kind: 'slots', running: 2, max: 2, repo: null });
  db.close();
});

test('daemon cap 2, two repos at 1 slot each, a queued task in each: both start', () => {
  const { db, repo, task } = setup();
  const other = db.addRepo({ name: 'o', path: '/tmp/o', base_branch: 'main' });
  const a = task('a');
  const b = db.addTask({ repo_id: other.id, title: 'b', prompt: 'p' });
  assert.equal(repo.max_concurrent, 1);
  assert.deepEqual([db.claimNextTask()?.id, db.claimNextTask()?.id].sort(), [a.id, b.id].sort());
  db.close();
});

test("daemon cap 2, one repo at 1 slot with two queued tasks: one starts, the other waits on the repo's slot", () => {
  const { db, task } = setup();
  const first = task('first');
  const second = task('second');
  assert.equal(db.claimNextTask()?.id, first.id);
  assert.equal(db.claimNextTask(), undefined);
  assert.equal(db.hasQueued(), false);
  assert.deepEqual(startWaits(db)(db.getTask(second.id)!, { kind: 'none' }), { kind: 'slots', running: 1, max: 1, repo: 'r' });
  db.close();
});

test("a repo raised to 2 slots runs two of its tasks at once, and the repo's slots save through repo set", () => {
  const { db, repo, task } = setup();
  const first = task('first');
  const second = task('second');
  updateRepo(db, repo.name, repoSettingPatch('max_concurrent', '2'));
  assert.equal(db.getRepo(repo.id)?.max_concurrent, 2);
  assert.deepEqual([db.claimNextTask()?.id, db.claimNextTask()?.id], [first.id, second.id]);
  assert.throws(() => updateRepo(db, repo.name, { max_concurrent: 9 }), /max_concurrent must be a whole number from 1 to 8/);
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
