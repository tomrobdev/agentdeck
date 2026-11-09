// A task going to queued has no stop reason; the timeline keeps the history.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../../../src/db/index.ts';
import { asTaskId } from '../../../src/domain/shared/id.ts';
import { type TaskEvent, transition } from '../../../src/domain/work/lifecycle/lifecycle.ts';
import { buildPlannerPrompt } from '../../../src/domain/proposals/proposals.ts';
import { type TaskState, stopReasonOf } from '../../../src/domain/work/task/task.ts';

function setup() {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  const task = db.addTask({ repo_id: repo.id, title: 'a task', prompt: 'p' });
  return { db, repo, id: task.id };
}

// Every way a task reaches queued from another status, with the status to start from.
const TO_QUEUED: [string, TaskEvent, 'blocked' | 'done' | 'running'][] = [
  ['retry', { type: 'retry' }, 'blocked'],
  ['unblock_retry', { type: 'unblock_retry' }, 'blocked'],
  ['review_retry', { type: 'review_retry' }, 'done'],
  ['rate_limited', { type: 'rate_limited' }, 'running'],
  ['recover', { type: 'recover' }, 'running'],
  ['finish:failed:retry', { type: 'finish', outcome: 'failed' }, 'running'],
];

for (const [name, event, from] of TO_QUEUED) {
  test(`${name}: the task has no stop reason, the timeline row keeps it`, () => {
    const { db, id } = setup();
    assert.ok(db.applyEvent(id, { type: 'claim' }));
    if (from === 'blocked') assert.ok(db.applyEvent(id, { type: 'finish', outcome: 'blocked' }, { reason: 'old reason' }));
    if (from === 'done') assert.ok(db.applyEvent(id, { type: 'finish', outcome: 'done' }));
    const before = db.getTask(id)!;
    assert.equal(before.status, from);
    assert.equal(stopReasonOf(before), from === 'blocked' ? 'old reason' : null);

    assert.ok(db.applyEvent(id, event, { reason: 'why it was queued again' }));
    const after = db.getTask(id)!;
    assert.equal(after.status, 'queued');
    assert.equal(stopReasonOf(after), null);
    const row = db.eventsForTask(id).at(-1)!;
    assert.equal(row.to_status, 'queued');
    assert.equal(row.reason, 'why it was queued again');
  });
}

test('transition leaves no stop reason whenever it leads to queued', () => {
  for (const [name, event, from] of TO_QUEUED) {
    const state: TaskState =
      from === 'blocked'
        ? { status: from, stop_reason: 'old reason', needs: null, question: null }
        : from === 'done'
          ? { status: from, done_by: null }
          : { status: from };
    const t = transition({ ...state, id: asTaskId(1), attempts: 1, max_attempts: 3, restarts: 0, pr: null }, event);
    assert.deepEqual(t?.state, { status: 'queued' }, name);
  }
});

test('the planner lists a queued task without a stop reason', () => {
  const { db, repo, id } = setup();
  assert.ok(db.applyEvent(id, { type: 'claim' }));
  assert.ok(db.applyEvent(id, { type: 'finish', outcome: 'blocked' }, { reason: 'needs the API key' }));
  assert.match(buildPlannerPrompt(repo, 'goals', db.tasksForRepo(repo.id), 3), /\[blocked\] a task \(needs the API key\)/);
  assert.ok(db.applyEvent(id, { type: 'retry' }));
  const prompt = buildPlannerPrompt(repo, 'goals', db.tasksForRepo(repo.id), 3);
  assert.match(prompt, new RegExp(`- #${id} \\[queued\\] a task\\n`));
  assert.doesNotMatch(prompt, /needs the API key/);
});
