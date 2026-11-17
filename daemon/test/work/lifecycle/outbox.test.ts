import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TaskId } from '#domain/shared/id.ts';
import { fakeCodeHost } from '#test/fixtures/fakes.ts';
import { asTaskId, testApp } from '#test/fixtures/fixtures.ts';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-outbox-'));
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('#db/index.ts');
const { Scheduler } = await import('#application/scheduler/scheduler.ts');
const { followUpPending, settle } = await import('#application/landing/settle.ts');
const { openPullRequest } = await import('#application/landing/pull-request/open-pr.ts');
const { cancelTask } = await import('#application/actions.ts');

function setup() {
  const codeHost = fakeCodeHost();
  const db = testApp(openDb(':memory:'), { codeHost });
  const repo = db.addRepo({ name: 'demo', path: '/tmp/demo', base_branch: 'main' });
  db.updateRepo(repo.id, { pr_mode: 'ready' });
  const add = (on: TaskId | null = null) =>
    db.addTask({ repo_id: repo.id, title: 'work', prompt: 'p', links: on === null ? [] : [{ on, kind: 'builds_on' }] });
  const finishedDone = () => {
    const task = add();
    assert.equal(db.claimNextTask()?.id, task.id);
    db.setCheckout(task.id, { branch: `agentdeck/task-${task.id}` });
    const applied = db.applyEvent(task.id, { type: 'finish', outcome: 'done' });
    assert.ok(applied);
    return { task, applied };
  };
  const notes = (id: TaskId, kind = 'done') => db.recentNotifications(50).filter((n) => n.task_id === id && n.kind === kind);
  return { db, codeHost, add, finishedDone, notes };
}

test('a status change with follow-ups writes its row pending, in the same transaction; one without writes none', () => {
  const { db, finishedDone } = setup();
  const { task, applied } = finishedDone();
  assert.equal(applied.pending.length, 1);
  assert.deepEqual(
    db.pendingFollowUps().map((r) => [r.id, r.task_id, r.type, r.to_status]),
    [[applied.pending[0], task.id, 'finish', 'done']],
    'the claim has no follow-ups, so it is not pending',
  );
  assert.ok(!('follow_up_pending' in db.eventsForTask(task.id)[0]), 'the timeline does not read the flag');
  db.close();
});

test('running a follow-up twice opens one PR and sends one notification', async () => {
  const { db, codeHost, finishedDone, notes } = setup();
  const { task } = finishedDone();
  assert.deepEqual(await Promise.all([followUpPending(db), followUpPending(db)]), [1, 0]);
  assert.equal(await followUpPending(db), 0);
  assert.equal(codeHost.created.length, 1);
  assert.equal(db.getTask(task.id)!.pr?.url, 'https://example.test/pull/1');
  assert.equal(notes(task.id).length, 1);
  assert.match(notes(task.id)[0].body, /PR: https:\/\/example\.test\/pull\/1/);
  assert.deepEqual(db.pendingFollowUps(), []);

  assert.deepEqual(await openPullRequest(db, db.getTask(task.id)!), { url: 'https://example.test/pull/1' });
  assert.equal(codeHost.created.length, 1);
  db.close();
});

test("a tick while settle opens the PR leaves settle's row to it: one PR", async () => {
  const { db, codeHost, add, notes } = setup();
  const task = add();
  assert.equal(db.claimNextTask()?.id, task.id);
  db.setCheckout(task.id, { branch: 'agentdeck/task-x' });
  let release!: () => void;
  const pushed = new Promise<void>((r) => (release = r));
  codeHost.push = () => pushed;
  const settling = settle(db, task.id, { type: 'finish', outcome: 'done' });
  assert.equal(db.pendingFollowUps().length, 1, 'pending until its follow-ups ran');
  assert.equal(await followUpPending(db), 0, 'locked by the settle in this process');
  release();
  await settling;
  assert.equal(codeHost.created.length, 1);
  assert.equal(notes(task.id).length, 1);
  assert.deepEqual(db.pendingFollowUps(), []);
  db.close();
});

test('the scheduler runs the follow-ups a dead daemon left: the PR opens once on restart', async () => {
  const { db, codeHost, finishedDone, notes } = setup();
  const { task } = finishedDone();
  await new Scheduler(db, { once: true, tickMs: 10, log: () => {} }).run();
  assert.equal(codeHost.created.length, 1);
  assert.equal(db.getTask(task.id)!.pr?.state, 'open');
  assert.equal(notes(task.id).length, 1);
  await new Scheduler(db, { once: true, tickMs: 10, log: () => {} }).run();
  assert.equal(codeHost.created.length, 1, 'a second restart opens nothing');
  db.close();
});

test('on a tick with a pending follow-up and a claimable task, the follow-up runs first', async () => {
  const { db, codeHost, add, finishedDone } = setup();
  db.setPaused(false);
  finishedDone();
  add();
  const order: string[] = [];
  const createPr = codeHost.createPr;
  codeHost.createPr = async (pr) => {
    order.push('follow-up');
    return createPr(pr);
  };
  db.claimNextTask = () => {
    order.push('claim');
    return undefined;
  };
  const scheduler = new Scheduler(db, { tickMs: 5, prRefreshMs: Infinity, autoPropose: false, log: () => {} });
  const running = scheduler.run();
  for (let i = 0; i < 200 && !order.includes('claim'); i++) await new Promise((r) => setTimeout(r, 5));
  scheduler.stop();
  await running;
  assert.deepEqual(order.slice(0, 2), ['follow-up', 'claim']);
  db.close();
});

test('an event row written without the column, as older code writes it, is never followed up', async () => {
  const { db, codeHost, add, notes } = setup();
  const task = add();
  assert.equal(db.claimNextTask()?.id, task.id);
  db.setCheckout(task.id, { branch: 'agentdeck/task-old' });
  db.raw.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
  db.raw.prepare("INSERT INTO task_events (task_id, type, from_status, to_status) VALUES (?, 'finish', 'running', 'done')").run(task.id);
  assert.deepEqual(db.pendingFollowUps(), []);
  assert.equal(await followUpPending(db), 0);
  await new Scheduler(db, { once: true, tickMs: 10, log: () => {} }).run();
  assert.equal(codeHost.created.length, 0);
  assert.equal(notes(task.id).length, 0);
  db.close();
});

test("a person's event waits in the outbox for the daemon, which warns the dependents once", async () => {
  const { db, add, notes } = setup();
  const dep = add();
  const dependent = add(dep.id);
  cancelTask(db, dep.id);
  assert.equal(notes(dep.id, 'blocked').length, 0, 'the CLI writes the event; only the daemon follows up');
  assert.equal(db.pendingFollowUps().length, 1);
  assert.equal(await followUpPending(db), 1);
  assert.equal(await followUpPending(db), 0);
  const warned = notes(dep.id, 'blocked');
  assert.equal(warned.length, 1);
  assert.match(warned[0].body, new RegExp(`#${dependent.id} `));
  db.close();
});

test('a follow-up for a task that moved on since tells no one about the status it left', async () => {
  const { db, add, notes } = setup();
  const task = add();
  assert.equal(db.claimNextTask()?.id, task.id);
  assert.ok(db.applyEvent(task.id, { type: 'finish', outcome: 'blocked' }, { reason: 'needs a key' }));
  assert.ok(db.applyEvent(task.id, { type: 'retry' }));
  assert.equal(await followUpPending(db), 1);
  assert.equal(notes(task.id, 'blocked').length, 0);
  assert.equal(db.getTask(asTaskId(task.id))!.status, 'queued');
  db.close();
});
