import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ListedTask, filterTasks } from '../src/domain/task/listing.ts';

function task(id: number, fields: Partial<ListedTask> = {}): ListedTask {
  return {
    id,
    repo_id: 1,
    title: `task ${id}`,
    status: 'queued',
    priority: 0,
    model: 'sonnet',
    max_turns: 40,
    attempts: 0,
    max_attempts: 2,
    branch: null,
    worktree: null,
    blocked_reason: null,
    source: 'manual',
    restarts: 0,
    pr_url: null,
    pr_state: null,
    after_task: null,
    created_at: '2026-10-18 10:00:00',
    updated_at: '2026-10-18 10:00:00',
    waiting: null,
    ...fields,
  };
}

const TASKS = [
  task(1, { status: 'done', pr_url: 'https://x/1', pr_state: 'merged', updated_at: '2026-10-18 12:00:00' }),
  task(2, { status: 'done', updated_at: '2026-10-18 09:00:00' }),
  task(3, { status: 'blocked', blocked_reason: 'permission refused', repo_id: 2 }),
  task(4, { status: 'queued', priority: 5, after_task: 3, waiting: { on: 3, stuck: '#3 is blocked' } }),
  task(5, { status: 'queued', after_task: 6, waiting: { on: 6, stuck: null } }),
  task(6, { status: 'running', title: 'Run workers in the sandbox', branch: 'agentdeck/task-6' }),
  task(7, { status: 'cancel_requested' }),
  task(8, { status: 'proposed', priority: 9 }),
];

const ids = (filter: Partial<Parameters<typeof filterTasks>[1]>) =>
  filterTasks(TASKS, { states: [], sort: 'newest', ...filter }).map((t) => t.id);

test('states pick out waiting and stuck tasks, and PR states of done tasks', () => {
  assert.deepEqual(ids({ states: ['stuck'] }), [4]);
  assert.deepEqual(ids({ states: ['waiting'] }), [5]);
  assert.deepEqual(ids({ states: ['queued'] }), [5, 4]);
  assert.deepEqual(ids({ states: ['running'] }), [7, 6], 'a task being stopped still counts as running');
  assert.deepEqual(ids({ states: ['merged'] }), [1]);
  assert.deepEqual(ids({ states: ['no-pr'] }), [2]);
  assert.deepEqual(ids({ states: ['merged', 'blocked'] }), [3, 1], 'several states match any of them');
});

test('groups match the dashboard tabs: a stuck task needs you and is not active', () => {
  assert.deepEqual(ids({ states: ['active'] }), [7, 6, 5]);
  assert.deepEqual(ids({ states: ['needs-you'] }), [8, 4, 3]);
});

test('repo and search narrow the list', () => {
  assert.deepEqual(ids({ repo_id: 2 }), [3]);
  assert.deepEqual(ids({ search: 'SANDBOX' }), [6]);
  assert.deepEqual(ids({ search: 'agentdeck/task' }), [6], 'branch');
  assert.deepEqual(ids({ search: 'permission' }), [3], 'blocked reason');
  assert.deepEqual(ids({ search: '#4' }), [4]);
  assert.deepEqual(ids({ states: ['done'], search: 'nothing like this' }), []);
});

test('sorts', () => {
  assert.deepEqual(ids({ sort: 'oldest' }), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(ids({ sort: 'priority' }).slice(0, 2), [8, 4]);
  assert.deepEqual(ids({ sort: 'updated' })[0], 1);
  assert.deepEqual(ids({ sort: 'attention' }), [7, 6, 8, 3, 4, 5, 2, 1]);
});

test('an unknown state or sort says which names are valid', () => {
  assert.throws(() => ids({ states: ['stalled'] }), /unknown state "stalled" \(use active, needs-you, proposed/);
  assert.throws(() => ids({ sort: 'random' }), /unknown sort "random" \(use attention, updated/);
});
