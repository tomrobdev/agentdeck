// A drain starts no queued task that never ran, waits for the work in flight and its follow-ups, then ends paused with a drained notification.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fakeCodeHost } from '#test/fixtures/fakes.ts';
import { testApp } from '#test/fixtures/fixtures.ts';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-drain-'));
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('#db/index.ts');
const { followUpPending } = await import('#application/landing/settle.ts');
const { finishDrains } = await import('#application/scheduler/drain.ts');
const { startWaits } = await import('#application/capacity/queue.ts');
const { archiveRepo, drain, drainRepo, resumeRepo, setPaused } = await import('#application/actions.ts');

function setup() {
  const db = testApp(openDb(':memory:'), { codeHost: fakeCodeHost() });
  db.setPaused(false);
  const web = db.addRepo({ name: 'web', path: '/tmp/web', base_branch: 'main' });
  const api = db.addRepo({ name: 'api', path: '/tmp/api', base_branch: 'main' });
  for (const r of [web, api]) db.updateRepo(r.id, { pr_mode: 'ready' });
  const add = (repo = web) => db.addTask({ repo_id: repo.id, title: 'work', prompt: 'p' });
  const ranOnce = (repo = web) => {
    const task = add(repo);
    assert.equal(db.claimNextTask()?.id, task.id);
    db.finishRun(db.startRun(task.id, 1, '/tmp/a.log'), {});
    assert.ok(db.applyEvent(task.id, { type: 'rate_limited' }));
    assert.equal(db.getTask(task.id)?.status, 'queued');
    return task;
  };
  const finish = (id: Parameters<typeof db.getTask>[0]) => {
    db.setCheckout(id, { branch: `agentdeck/task-${id}` });
    assert.ok(db.applyEvent(id, { type: 'finish', outcome: 'done' }));
  };
  const idle = { busy: false, follow_ups: 0, reviews: 0 };
  const tick = (work = idle) => finishDrains(db, { ...work, follow_ups: db.pendingFollowUps().length }, () => {});
  const drained = () => db.recentNotifications(50).filter((n) => n.kind === 'drained');
  return { db, web, api, add, ranOnce, finish, idle, tick, drained };
}

test('a daemon drain starts only the tasks that ran before, waits for their follow-ups, then pauses and says drained', async () => {
  const { db, add, ranOnce, finish, idle, tick, drained } = setup();
  const retry = ranOnce();
  const fresh = add();

  assert.deepEqual(drain(db), { draining: true });
  assert.equal(db.claimNextTask(db.draining())?.id, retry.id, 'the retry carries on');
  assert.equal(db.claimNextTask(db.draining()), undefined, 'a queued task that never ran does not start');
  assert.equal(db.hasQueued(db.draining()), false);
  assert.deepEqual(startWaits(db)(db.getTask(fresh.id)!, { kind: 'none' }), { kind: 'draining', repo: false });

  tick();
  assert.equal(db.isPaused(), false, 'a task is still running');
  finish(retry.id);
  tick();
  assert.equal(db.isPaused(), false, 'its follow-ups have not run');
  tick({ ...idle, busy: true });
  assert.equal(await followUpPending(db), 1);
  tick({ ...idle, busy: true });
  assert.equal(db.isPaused(), false, 'the scheduler still has work under way');
  tick({ ...idle, reviews: 1 });
  assert.equal(db.isPaused(), false, 'a review run is still to come');

  tick();
  assert.equal(db.isPaused(), true);
  assert.equal(db.draining().daemon, false);
  assert.equal(db.getTask(fresh.id)?.status, 'queued', 'the fresh task waits for a resume');
  assert.deepEqual(
    drained().map((n) => n.title),
    ['AgentDeck drained'],
  );
  tick();
  assert.equal(drained().length, 1, 'told once');
  db.close();
});

test('a paused daemon does not drain, and a resume ends a drain', () => {
  const { db, add } = setup();
  db.setPaused(true);
  assert.deepEqual(drain(db), { draining: false });
  setPaused(db, false);
  drain(db);
  setPaused(db, false);
  assert.equal(db.draining().daemon, false);
  const task = add();
  assert.equal(db.claimNextTask(db.draining())?.id, task.id);
  db.close();
});

test('a repo drain waits for its own runs alone, then pauses only that repo', () => {
  const { db, web, api, add, tick, drained } = setup();
  const busyElsewhere = add(api);
  assert.equal(db.claimNextTask()?.id, busyElsewhere.id);
  const blocked = add();
  const unblock = db.startRun(blocked.id, 0, '/tmp/u.log', 'unblock');
  const fresh = add();
  const freshApi = add(api);

  drainRepo(db, 'web');
  assert.equal(db.claimNextTask(db.draining())?.id, freshApi.id, 'another repo carries on');
  assert.equal(db.claimNextTask(db.draining()), undefined, `#${fresh.id} in the draining repo waits`);
  assert.deepEqual(startWaits(db)(db.getTask(fresh.id)!, { kind: 'none' }), { kind: 'draining', repo: true });

  tick();
  assert.equal(db.getRepo(web.id)?.paused_reason, null, 'its unblock run is still going');
  db.finishRun(unblock, {});
  tick();
  assert.equal(db.getRepo(web.id)?.paused_reason, 'drained');
  assert.equal(db.getRepo(api.id)?.paused_reason, null);
  assert.equal(db.isPaused(), false);
  assert.deepEqual(db.draining().repos, []);
  assert.deepEqual(
    drained().map((n) => n.title),
    ['Drained web'],
  );

  assert.throws(() => drainRepo(db, 'web'), /web is paused already/);
  resumeRepo(db, 'web');
  drainRepo(db, 'web');
  resumeRepo(db, 'web');
  assert.deepEqual(db.draining().repos, []);
  assert.equal(db.claimNextTask(db.draining())?.id, blocked.id);
  assert.equal(db.claimNextTask(db.draining())?.id, fresh.id);
  db.addRepo({ name: 'old', path: '/tmp/old', base_branch: 'main' });
  archiveRepo(db, 'old');
  assert.throws(() => drainRepo(db, 'old'), /old is archived/);
  db.close();
});
