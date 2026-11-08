// Settling a task: one call applies the event and what follows it; every pr_state write is guarded and recorded.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TaskId } from '../src/domain/shared/id.ts';
import { asTaskId, testApp } from './fixtures.ts';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-settle-'));
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('../src/db/index.ts');
const { github } = await import('../src/adapters/github.ts');
const { Scheduler } = await import('../src/application/scheduler/scheduler.ts');
const { closePullRequest } = await import('../src/application/landing/merge.ts');
const { refreshPrStates } = await import('../src/application/landing/refresh.ts');
const { openPullRequest } = await import('../src/application/landing/open-pr.ts');
const { parsePrDetails } = await import('../src/domain/landing/merge.ts');
const { finalNotification } = await import('../src/domain/operations/notification.ts');
const { MAX_RESTARTS } = await import('../src/domain/work/lifecycle.ts');

function setup(pr_mode: 'off' | 'ready' = 'off') {
  const db = testApp(openDb(':memory:'));
  const repo = db.addRepo({ name: 'demo', path: '/tmp/demo', base_branch: 'main' });
  db.raw.prepare('UPDATE repos SET pr_mode = ? WHERE id = ?').run(pr_mode, repo.id);
  const add = (after_task: number | null = null) =>
    db.addTask({
      repo_id: repo.id,
      title: `task ${after_task ?? 'a'}`,
      prompt: 'p',
      links: after_task == null ? [] : [{ on: asTaskId(after_task), kind: 'builds_on' }],
    });
  return { db, repo, add };
}

const notes = (db: ReturnType<typeof openDb>, kind: string, id: TaskId) =>
  db.recentNotifications(50).filter((n) => n.kind === kind && n.task_id === id);
const prRows = (db: ReturnType<typeof openDb>, id: TaskId) => db.eventsForTask(id).filter((e) => e.type === 'pr' || e.type === 'pr_closed');

test('a worker that throws leaves its task failed, notified, and its dependents warned', async () => {
  const { db, add } = setup();
  const task = add();
  const dependent = add(task.id);
  // runTask's first read of the repo throws; settling reads it again for the notification.
  const getRepo = db.getRepo;
  let calls = 0;
  db.getRepo = (id) => {
    if (calls++ === 0) throw new Error('boom');
    return getRepo(id);
  };
  await new Scheduler(db, { once: true, tickMs: 20, log: () => {} }).run();

  const t = db.getTask(task.id)!;
  assert.equal(t.status, 'failed');
  assert.equal(t.stop_reason, 'boom');
  assert.equal(notes(db, 'failed', task.id).length, 1);
  assert.match(notes(db, 'failed', task.id)[0].title, /^#\d+ failed: /);
  const warning = notes(db, 'blocked', task.id);
  assert.equal(warning.length, 1, 'the dependent is warned');
  assert.match(warning[0].body, new RegExp(`#${dependent.id}`));
  assert.equal(db.getTask(dependent.id)!.status, 'queued');
  db.close();
});

test('a task failed by crash recovery gets a notification', async () => {
  const { db, add } = setup();
  const task = add();
  assert.equal(db.claimNextTask()?.id, task.id);
  db.raw.prepare('UPDATE tasks SET restarts = ? WHERE id = ?').run(MAX_RESTARTS - 1, task.id);
  await new Scheduler(db, { once: true, tickMs: 20, log: () => {} }).run();
  assert.equal(db.getTask(task.id)!.status, 'failed');
  assert.equal(notes(db, 'failed', task.id).length, 1);
  db.close();
});

test('finalNotification words done, blocked and failed, and nothing else', () => {
  const t = {
    id: asTaskId(3),
    title: 'Do it',
    checkout: { branch: 'agentdeck/task-3', worktree: null, syncing_since: null },
  };
  assert.deepEqual(finalNotification({ ...t, status: 'done', done_by: null }, 'demo', { url: 'https://x/pull/1' }), {
    kind: 'done',
    title: '#3 done: Do it',
    body: 'Ready to review on agentdeck/task-3 in demo. PR: https://x/pull/1',
    task_id: 3,
  });
  assert.equal(finalNotification({ ...t, status: 'failed', stop_reason: 'tests failed' }, 'demo')?.body, 'tests failed (demo)');
  assert.match(finalNotification({ ...t, status: 'done', done_by: null }, '', { error: 'no gh' })!.body, /Could not open a PR: no gh$/);
  assert.equal(finalNotification({ ...t, status: 'queued' }, 'demo'), null);
});

test('opening, failing and closing a PR each add one pr row to the history', async () => {
  const { db, add } = setup('ready');
  const task = add();
  db.claimNextTask();
  db.applyEvent(task.id, { type: 'finish', outcome: 'done' });
  db.setCheckout(task.id, { branch: 'agentdeck/task-x' });
  github.push = async () => {};
  github.closePr = async () => {};

  github.createPr = async () => 'https://x/pull/7';
  assert.deepEqual(await openPullRequest(db, db.getTask(task.id)!), { url: 'https://x/pull/7' });
  assert.equal(prRows(db, task.id).length, 1);
  assert.equal(db.getTask(task.id)!.pr?.state, 'open');

  await closePullRequest(db, db.getTask(task.id)!);
  assert.equal(prRows(db, task.id).length, 2);
  assert.equal(db.getTask(task.id)!.pr?.state, 'closed');

  github.createPr = async () => {
    throw new Error('gh broke');
  };
  assert.deepEqual(await openPullRequest(db, db.getTask(task.id)!), { error: 'gh broke' });
  assert.equal(db.getTask(task.id)!.pr?.state, 'failed');

  const rows = prRows(db, task.id);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => [r.from_status, r.to_status, r.reason]),
    [
      ['done', 'done', 'opened https://x/pull/7'],
      ['done', 'done', 'closed without merging'],
      ['done', 'done', 'could not open the PR: gh broke'],
    ],
  );
  db.close();
});

test('a refresh does not undo a merge recorded while it waited on GitHub', async () => {
  for (const seen of ['open', 'closed'] as const) {
    const { db, add } = setup('ready');
    const task = add();
    db.claimNextTask();
    db.applyEvent(task.id, { type: 'finish', outcome: 'done' });
    db.recordPr(task.id, { type: 'opened', url: 'https://x/pull/9' });
    github.prDetails = async () => {
      db.recordMerge(task.id, 'squash', 'squash merge');
      return parsePrDetails(JSON.stringify({ state: seen.toUpperCase() }));
    };
    await refreshPrStates(db);
    assert.equal(db.getTask(task.id)!.pr?.state, 'merged', `GitHub said ${seen}`);
    assert.equal(prRows(db, task.id).length, 1, 'only the opening is recorded');
    db.close();
  }
});

test('a PR merged on GitHub settles a blocked task as done, notifying and opening no second PR', async () => {
  const { db, add } = setup('ready');
  const task = add();
  db.claimNextTask();
  db.applyEvent(task.id, { type: 'finish', outcome: 'done' });
  db.recordPr(task.id, { type: 'opened', url: 'https://x/pull/10' });
  db.applyEvent(task.id, { type: 'conflict' }, { reason: 'conflicts' });
  let created = 0;
  github.createPr = async () => String(++created);
  github.prDetails = async () => parsePrDetails(JSON.stringify({ state: 'MERGED' }));
  await refreshPrStates(db);
  const t = db.getTask(task.id)!;
  assert.deepEqual([t.status, t.pr?.state], ['done', 'merged']);
  assert.equal(created, 0);
  assert.equal(notes(db, 'done', task.id).length, 1);
  db.close();
});
