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
    stop_reason: null,
    source: 'manual',
    restarts: 0,
    pr_url: null,
    pr_state: null,
    merge_method: null,
    plan_path: null,
    plan_steps: null,
    needs: null,
    question: null,
    done_by: null,
    auto_merge: null,
    auto_merge_check: null,
    auto_merge_checked_at: null,
    pr_checks: null,
    syncing_since: null,
    pr_checks_opened: null,
    pr_checks_merged: null,
    merge_requested_at: null,
    merge_request_method: null,
    merge_request_check: null,
    plan_task: null,
    created_at: '2026-10-18 10:00:00',
    updated_at: '2026-10-18 10:00:00',
    waiting: null,
    unblocks: [],
    ...fields,
  };
}

const TASKS = [
  task(1, { status: 'done', pr_url: 'https://x/1', pr_state: 'merged', updated_at: '2026-10-18 12:00:00' }),
  task(2, { status: 'done', updated_at: '2026-10-18 09:00:00' }),
  task(3, { status: 'blocked', stop_reason: 'permission refused', repo_id: 2 }),
  task(4, { status: 'queued', priority: 5, waiting: { on: [3], stuck: '#3 is blocked' } }),
  task(5, { status: 'queued', waiting: { on: [6], stuck: null } }),
  task(6, { status: 'running', title: 'Run workers in the sandbox', branch: 'agentdeck/task-6' }),
  task(7, { status: 'cancel_requested' }),
  task(8, { status: 'proposed', priority: 9 }),
  task(9, { status: 'done', pr_url: 'https://x/9', pr_state: 'open' }),
  task(10, { status: 'done', pr_url: 'https://x/10', pr_state: 'open', unblocks: [5] }),
  task(11, { status: 'done', pr_url: 'https://x/11', pr_state: 'merged' }),
  task(12, { status: 'cancelled' }),
  task(13, { status: 'done', pr_url: 'https://x/13', pr_state: 'closed' }),
];

const ids = (filter: Partial<Parameters<typeof filterTasks>[1]>) =>
  filterTasks(TASKS, { states: [], sort: 'newest', ...filter }).map((t) => t.id);

test('states pick out waiting and stuck tasks, and PR states of done tasks', () => {
  assert.deepEqual(ids({ states: ['stuck'] }), [4]);
  assert.deepEqual(ids({ states: ['waiting'] }), [5]);
  assert.deepEqual(ids({ states: ['queued'] }), [5, 4]);
  assert.deepEqual(ids({ states: ['running'] }), [7, 6], 'a task being stopped still counts as running');
  assert.deepEqual(ids({ states: ['merged'] }), [11, 1]);
  assert.deepEqual(ids({ states: ['no-pr'] }), [2]);
  assert.deepEqual(ids({ states: ['merged', 'blocked'] }), [11, 3, 1], 'several states match any of them');
});

test('groups match the dashboard: a stuck task needs you and is not active', () => {
  assert.deepEqual(ids({ states: ['active'] }), [7, 6, 5]);
  assert.deepEqual(ids({ states: ['needs-you'] }), [4, 3]);
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
  assert.deepEqual(ids({ sort: 'oldest' }), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.deepEqual(ids({ sort: 'priority' }).slice(0, 2), [8, 4]);
  assert.deepEqual(ids({ sort: 'updated' })[0], 1);
  assert.deepEqual(
    ids({ sort: 'attention' }),
    [4, 3, 10, 9, 8, 7, 6, 5, 13, 11, 2, 1, 12],
    'needs you, review (the PR others wait on first), proposed, running, queued, done (merged or not), cancelled',
  );
});

test('review is a done task whose PR is open', () => {
  assert.deepEqual(ids({ states: ['review'] }), [10, 9]);
  assert.deepEqual(ids({ states: ['pr-open'] }), [10, 9], 'the older name still works');
  assert.deepEqual(ids({ states: ['review', 'blocked'] }), [10, 9, 3]);
});

test('an unknown state or sort says which names are valid', () => {
  assert.throws(() => ids({ states: ['stalled'] }), /unknown state "stalled" \(use active, needs-you, running/);
  assert.throws(() => ids({ sort: 'random' }), /unknown sort "random" \(use attention, updated/);
});
