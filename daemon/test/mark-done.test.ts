// Marking a task done by hand: the mark_done event, done_by, and the dependency rule in SQL and in the domain.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-markdone-'));
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('../src/db/index.ts');
const { dependencyState } = await import('../src/domain/task/dependency.ts');
const { TASK_STATUSES } = await import('../src/domain/task/lifecycle.ts');
const { markDone, retryTask, ActionError } = await import('../src/application/actions.ts');
const { dependencyOf } = await import('../src/application/dependencies.ts');
type Db = ReturnType<typeof openDb>;
type TaskStatus = (typeof TASK_STATUSES)[number];

function setup() {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  const add = (after_task?: number) => db.addTask({ repo_id: repo.id, title: 't', prompt: 'p', after_task });
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
    assert.equal(done.stop_reason, null);
    assert.equal(done.needs, null);
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
    assert.equal(db.getTask(t.id)!.done_by, null);
    db.close();
  }
});

test('done_by is cleared when the task leaves done', () => {
  const { db, add } = setup();
  const t = add();
  bring(db, t.id, 'failed');
  db.applyEvent(t.id, { type: 'mark_done' });
  assert.equal(db.getTask(t.id)!.done_by, 'person');
  const retried = db.applyEvent(t.id, { type: 'retry' })!;
  assert.equal(retried.status, 'queued');
  assert.equal(retried.done_by, null);

  const c = add();
  bring(db, c.id, 'blocked');
  db.applyEvent(c.id, { type: 'mark_done' });
  assert.equal(db.applyEvent(c.id, { type: 'conflict' })!.done_by, null, 'a conflict blocks it again');
  db.close();
});

test('pr_merged also moves blocked and failed tasks to done, without done_by', () => {
  const { db, add } = setup();
  const t = add();
  bring(db, t.id, 'blocked');
  const done = db.applyEvent(t.id, { type: 'pr_merged' })!;
  assert.equal(done.status, 'done');
  assert.equal(done.stop_reason, null);
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
  assert.equal(db.getTask(b.id)!.done_by, null);
  db.close();
});

// A dependency per status, pr_state, pr_mode and done_by: the SQL claim rule and the domain rule must agree.
test('the SQL and the domain agree on when a dependency is met', () => {
  const STATUSES: TaskStatus[] = ['queued', 'running', 'done', 'blocked', 'failed', 'cancelled'];
  const PR_STATES = [null, 'open', 'merged', 'closed', 'failed'] as const;
  let cases = 0;
  for (const status of STATUSES)
    for (const pr_state of PR_STATES)
      for (const pr_mode of ['off', 'draft'])
        for (const done_by of [null, 'person'] as const) {
          const { db, repo, add } = setup();
          db.updateRepo(repo.id, { pr_mode: pr_mode as 'off' | 'draft' });
          const dep = add();
          const later = add(dep.id);
          // Put the dependency in the state under test; `later` stays queued behind it.
          db.updateTask(dep.id, { pr_url: pr_state ? 'https://x/pull/1' : null, pr_state });
          bringTo(db, dep.id, status, done_by);
          const d = db.getTask(dep.id)!;
          const sqlMet = db.hasQueued() && db.claimNextTask()?.id === later.id;
          const domainMet = dependencyState({ after_task: dep.id }, { ...d, pr_mode }).kind === 'met';
          assert.equal(sqlMet, domainMet, `${status} pr_state=${pr_state} pr_mode=${pr_mode} done_by=${done_by}`);
          assert.equal(dependencyOf(db, later).kind === 'met', domainMet);
          cases++;
          db.close();
        }
  assert.equal(cases, STATUSES.length * PR_STATES.length * 2 * 2);
});

/** Put a task in `status` with `done_by` set, the way a person (or the worker) would have; later tasks stay queued. */
function bringTo(db: Db, id: number, status: TaskStatus, done_by: 'person' | null): void {
  // The dependency must not be claimed ahead of its dependent in this setup, so take it by id.
  const claim = () => {
    const t = db.claimNextTask();
    assert.equal(t?.id, id);
  };
  switch (status) {
    case 'queued':
      return;
    case 'running':
      return claim();
    case 'cancelled':
      return void db.applyEvent(id, { type: 'cancel' });
    case 'done':
      claim();
      db.applyEvent(id, { type: 'finish', outcome: 'done' });
      if (done_by) {
        db.applyEvent(id, { type: 'conflict' });
        db.applyEvent(id, { type: 'mark_done' });
      }
      return;
    case 'blocked':
    case 'failed':
      claim();
      db.applyEvent(
        id,
        status === 'blocked' ? { type: 'finish', outcome: 'blocked' } : { type: 'finish', outcome: 'failed', retry: false },
      );
      return;
  }
}

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
  bring(db, dep2.id, 'failed');
  db.updateTask(dep2.id, { pr_url: 'https://x/pull/2', pr_state: 'open' });
  markDone(db, dep2.id);
  assert.equal(db.claimNextTask(), undefined, 'person-done with an open PR waits for the merge');
  db.updateTask(dep2.id, { pr_state: 'merged' });
  assert.equal(db.claimNextTask()!.id, later2.id);
  db.close();
});
