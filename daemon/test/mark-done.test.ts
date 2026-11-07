// Marking a task done by hand: the mark_done event, done_by, and the dependency rule in SQL and in the domain.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stateFields } from '../src/domain/task/task.ts';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-markdone-'));
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('../src/db/index.ts');
const { advance, settlePr } = await import('./fixtures.ts');
const { linkState } = await import('../src/domain/task/link.ts');
const { TASK_STATUSES } = await import('../src/domain/task/lifecycle.ts');
const { markDone, retryTask, ActionError } = await import('../src/application/actions.ts');
const { dependencyOf, liveLinks } = await import('../src/application/task/dependencies.ts');
type Db = ReturnType<typeof openDb>;
type TaskStatus = (typeof TASK_STATUSES)[number];

function setup() {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  const add = (after_task?: number) =>
    db.addTask({
      repo_id: repo.id,
      title: 't',
      prompt: 'p',
      links: after_task === undefined ? [] : [{ on: after_task, kind: 'builds_on' }],
    });
  return { db, repo, add };
}

/** Move a queued task to `status` through its events. */
function bring(db: Db, id: number, status: TaskStatus): void {
  const claim = () => assert.ok(db.applyEvent(id, { type: 'claim' }));
  switch (status) {
    case 'queued':
    case 'proposed': // added as a proposal by the caller
      return;
    case 'running':
      return claim();
    case 'done':
      claim();
      return void db.applyEvent(id, { type: 'finish', outcome: 'done' });
    case 'blocked':
      claim();
      return void db.applyEvent(id, { type: 'finish', outcome: 'blocked' }, { reason: 'stuck' });
    case 'failed':
      claim();
      return void db.applyEvent(id, { type: 'finish', outcome: 'failed', retry: false }, { reason: 'broke' });
    case 'cancel_requested':
      claim();
      return void db.applyEvent(id, { type: 'cancel' });
    case 'cancelled':
      return void db.applyEvent(id, { type: 'cancel' });
  }
}

test('mark_done moves blocked and failed tasks to done, clears the reason and needs, and uses no attempt', () => {
  for (const from of ['blocked', 'failed'] as const) {
    const { db, add } = setup();
    const t = add();
    bring(db, t.id, from);
    const before = db.getTask(t.id)!;
    assert.equal(before.status, from);
    assert.equal(before.stop_reason !== null, true);
    const done = db.applyEvent(t.id, { type: 'mark_done' }, { reason: 'landed by hand' })!;
    assert.equal(done.status, 'done');
    assert.equal(done.attempts, before.attempts);
    assert.equal(done.max_attempts, before.max_attempts);
    assert.equal(stateFields(done).stop_reason, null);
    assert.equal(stateFields(done).needs, null);
    assert.equal(done.done_by, 'person');
    const last = db.eventsForTask(t.id).at(-1)!;
    assert.deepEqual([last.type, last.from_status, last.to_status, last.reason], ['mark_done', from, 'done', 'landed by hand']);
    db.close();
  }
});

test('mark_done is refused from every other status', () => {
  for (const from of TASK_STATUSES.filter((s) => s !== 'blocked' && s !== 'failed')) {
    const { db, add } = setup();
    const t = from === 'proposed' ? db.addTask({ repo_id: db.listRepos()[0].id, title: 't', prompt: 'p', status: 'proposed' }) : add();
    bring(db, t.id, from);
    assert.equal(db.applyEvent(t.id, { type: 'mark_done' }), undefined, from);
    assert.equal(db.getTask(t.id)!.status, from);
    assert.equal(stateFields(db.getTask(t.id)!).done_by, null);
    db.close();
  }
});

test('done_by is cleared when the task leaves done', () => {
  const { db, add } = setup();
  const t = add();
  bring(db, t.id, 'failed');
  db.applyEvent(t.id, { type: 'mark_done' });
  assert.equal(stateFields(db.getTask(t.id)!).done_by, 'person');
  const retried = db.applyEvent(t.id, { type: 'retry' })!;
  assert.equal(retried.status, 'queued');
  assert.equal(stateFields(retried).done_by, null);

  const c = add();
  bring(db, c.id, 'blocked');
  db.applyEvent(c.id, { type: 'mark_done' });
  assert.equal(stateFields(db.applyEvent(c.id, { type: 'conflict' })!).done_by, null, 'a conflict blocks it again');
  db.close();
});

test('pr_merged also moves blocked and failed tasks to done, without done_by', () => {
  const { db, add } = setup();
  const t = add();
  bring(db, t.id, 'blocked');
  const done = db.applyEvent(t.id, { type: 'pr_merged' })!;
  assert.equal(done.status, 'done');
  assert.equal(stateFields(done).stop_reason, null);
  assert.equal(done.done_by, null);
  db.close();
});

test('markDone names the status when it is refused, and keeps the note', () => {
  const { db, add } = setup();
  const q = add();
  assert.throws(
    () => markDone(db, q.id),
    (e: Error) => e instanceof ActionError && /#\d+ is queued/.test(e.message),
  );
  assert.throws(() => markDone(db, 999), ActionError);
  const b = add();
  bring(db, b.id, 'blocked');
  markDone(db, b.id, '  merged it myself ');
  assert.equal(db.getTask(b.id)!.status, 'done');
  assert.equal(db.eventsForTask(b.id).at(-1)!.reason, 'merged it myself');
  retryTask(db, b.id);
  assert.equal(stateFields(db.getTask(b.id)!).done_by, null);
  db.close();
});

// A dependency per status, pr_state, pr_mode and done_by: the SQL claim rule and the domain rule must agree.
test('the SQL and the domain agree on when a dependency is met', () => {
  const STATUSES: TaskStatus[] = ['queued', 'running', 'done', 'blocked', 'failed', 'cancelled'];
  const PR_STATES = [null, 'open', 'merged', 'closed', 'failed'] as const;
  let cases = 0;
  for (const status of STATUSES)
    for (const pr_state of PR_STATES)
      for (const pr_mode of ['off', 'draft'] as const)
        for (const done_by of [null, 'person'] as const) {
          const { db, repo, add } = setup();
          db.updateRepo(repo.id, { pr_mode });
          const dep = add();
          const later = add(dep.id);
          // Put the dependency in the state under test; `later` stays queued behind it.
          advance(db, dep.id, status, { pr: pr_state, doneBy: done_by });
          const d = db.getTask(dep.id)!;
          const sqlMet = db.hasQueued() && db.claimNextTask()?.id === later.id;
          const domainMet = linkState({ on: dep.id, kind: 'builds_on' }, { ...d, pr_mode }).kind === 'met';
          assert.equal(sqlMet, domainMet, `${status} pr_state=${pr_state} pr_mode=${pr_mode} done_by=${done_by}`);
          assert.equal(dependencyOf(later, liveLinks(db)).kind === 'met', domainMet);
          cases++;
          db.close();
        }
  assert.equal(cases, STATUSES.length * PR_STATES.length * 2 * 2);
});

test('a task after a person-done task starts unless that task has an open PR', async () => {
  const { db, add } = setup();
  const dep = add();
  const later = add(dep.id);
  bring(db, dep.id, 'blocked');
  assert.equal(db.claimNextTask(), undefined, 'a blocked dependency holds it');
  markDone(db, dep.id);
  assert.equal(db.claimNextTask()!.id, later.id, 'person-done with no PR releases it');

  const dep2 = add();
  const later2 = add(dep2.id);
  advance(db, dep2.id, 'failed', { pr: 'open' }); // a retry that failed keeps the PR it had
  markDone(db, dep2.id);
  assert.equal(db.claimNextTask(), undefined, 'person-done with an open PR waits for the merge');
  settlePr(db, dep2.id, 'merged');
  assert.equal(db.claimNextTask()!.id, later2.id);
  db.close();
});
