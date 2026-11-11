// What the bulk bar offers: the actions every selected task allows. The dashboard has no test runner, so it is tested here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildsOnChain,
  bulkActions,
  bulkEditMessage,
  bulkMessage,
  idRange,
  keepPicked,
  mergeAllIds,
  pickAll,
  planBulkEdit,
  summarizeBulk,
  toggleGroupPicks,
} from '#app/lib/work/queue/bulk.ts';

const task = (status: string, extra: Record<string, unknown> = {}) => ({ id: 1, status, pr_state: null, pr_url: null, ...extra }) as never;

test('three proposals can be approved or rejected together', () => {
  assert.deepEqual(bulkActions([task('proposed'), task('proposed'), task('proposed')]), ['approve', 'reject']);
});

test('only what every task allows is offered', () => {
  assert.deepEqual(bulkActions([task('proposed'), task('queued')]), []);
  assert.deepEqual(bulkActions([task('failed'), task('blocked')]), ['retry', 'cancel']);
});

test('done tasks with open PRs can be merged together', () => {
  const open = task('done', { pr_state: 'open', pr_url: 'u' });
  assert.ok(bulkActions([open, open]).includes('merge'));
  assert.ok(!bulkActions([open, task('done', { pr_state: 'merged', pr_url: 'u' })]).includes('merge'));
});

test('a task in review that is syncing or has a merge request is not offered for a merge', () => {
  const open = task('done', { pr_state: 'open', pr_url: 'u' });
  const syncing = task('done', { pr_state: 'open', pr_url: 'u', sync: { since: null, resolving: false } });
  const requested = task('done', {
    pr_state: 'open',
    pr_url: 'u',
    merge_request: { state: 'waiting', method: 'squash', reasons: [], since: 'x' },
  });
  assert.ok(!bulkActions([open, syncing]).includes('merge'));
  assert.ok(!bulkActions([requested]).includes('merge'));
});

test("Merge all takes the Review group's tasks that may start a merge, and nothing from another group", () => {
  const t = (id: number, extra: Record<string, unknown> = {}) => task('done', { pr_state: 'open', pr_url: 'u', ...extra, id });
  const tasks = [t(1), t(2, { sync: { since: null, resolving: false } }), t(3, { merge_request: { state: 'waiting' } }), t(4)];
  assert.deepEqual(mergeAllIds({ key: 'review', tasks }), [1, 4]);
  assert.deepEqual(mergeAllIds({ key: 'done', tasks }), []);
});

test('nothing selected offers nothing', () => {
  assert.deepEqual(bulkActions([]), []);
});

test('a bulk action is summed up, with each failure and its reason', () => {
  const results = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 253, error: 'not proposed' }];
  assert.equal(summarizeBulk('approve', results), '4 approved · 1 failed');
  assert.equal(bulkMessage('approve', results), '4 approved · #253 failed: not proposed');
  assert.equal(summarizeBulk('retry', [{ id: 1, error: 'x' }]), '1 failed');
  assert.equal(summarizeBulk('cancel', [{ id: 1 }]), '1 cancelled');
});

const node = (id: number, status: string, links: [number, 'builds_on' | 'after'][] = []) =>
  ({ id, status, links: links.map(([on, kind]) => ({ on, kind })) }) as never;

test('a chain is the task and what it builds on, however far', () => {
  const shown = [node(239, 'queued'), node(240, 'queued', [[239, 'builds_on']]), node(241, 'queued', [[240, 'builds_on']])];
  assert.deepEqual(buildsOnChain(shown, 241), [239, 240, 241]);
  assert.deepEqual(buildsOnChain(shown, 239), [239]);
});

test('a diamond lists each task once, and the chain leaves out done tasks, after links and tasks not shown', () => {
  const shown = [
    node(1, 'queued'),
    node(2, 'queued', [[1, 'builds_on']]),
    node(3, 'queued', [[1, 'builds_on']]),
    node(4, 'queued', [
      [2, 'builds_on'],
      [3, 'builds_on'],
    ]),
    node(5, 'done'),
    node(6, 'queued', [
      [4, 'after'],
      [5, 'builds_on'],
      [99, 'builds_on'],
    ]),
  ];
  assert.deepEqual(buildsOnChain(shown, 4), [1, 2, 3, 4]);
  assert.deepEqual(buildsOnChain(shown, 6), [6]);
  assert.deepEqual(buildsOnChain(shown, 7), [7]);
});

test('picking all adds what the filter shows, and a group toggles as one', () => {
  assert.deepEqual(pickAll([9, 2], [1, 2, 3]), [9, 2, 1, 3]);
  assert.deepEqual(toggleGroupPicks([1], [1, 2]), [1, 2]);
  assert.deepEqual(toggleGroupPicks([1, 2, 5], [1, 2]), [5]);
});

test('a pick survives a collapsed group and goes only when its task leaves the filtered set', () => {
  assert.deepEqual(keepPicked([1, 2, 3], [1, 2, 3, 4]), [1, 2, 3]);
  assert.deepEqual(keepPicked([1, 2, 3], [1, 3]), [1, 3]);
});

test('a shift-click range runs either way and falls back to the one row', () => {
  assert.deepEqual(idRange([1, 2, 3, 4], 2, 4), [2, 3, 4]);
  assert.deepEqual(idRange([1, 2, 3, 4], 4, 2), [2, 3, 4]);
  assert.deepEqual(idRange([1, 2, 3, 4], null, 3), [3]);
});

test('priority and model are left out of tasks that are not editable, with the reason', () => {
  const picked = [task('proposed', { id: 1 }), task('queued', { id: 2 }), task('running', { id: 3 }), task('done', { id: 4 })];
  const plan = planBulkEdit(picked, 'priority');
  assert.deepEqual(plan.allowed, [1, 2]);
  assert.deepEqual(
    plan.left.map((l) => l.id),
    [3, 4],
  );
  assert.match(plan.left[0].reason, /is running; only proposed, queued, blocked, failed/);
  assert.deepEqual(planBulkEdit(picked, 'model').allowed, [1, 2]);
});

test('a builds-on link goes only on a task that has not started, and never on itself', () => {
  const picked = [task('proposed', { id: 1 }), task('queued', { id: 2 }), task('blocked', { id: 3 }), task('queued', { id: 9 })];
  const plan = planBulkEdit(picked, 'builds_on', 9);
  assert.deepEqual(plan.allowed, [1, 2]);
  assert.deepEqual(
    plan.left.map((l) => l.id),
    [3, 9],
  );
  assert.deepEqual(planBulkEdit(picked, 'after', 9).allowed, [1, 2, 3]);
});

test('auto-merge is left out of a cancelled task and of one whose PR is merged or closed', () => {
  const picked = [task('done', { id: 1, pr_state: 'open' }), task('done', { id: 2, pr_state: 'merged' }), task('cancelled', { id: 3 })];
  const plan = planBulkEdit(picked, 'auto_merge');
  assert.deepEqual(plan.allowed, [1]);
  assert.deepEqual(
    plan.left.map((l) => l.id),
    [2, 3],
  );
});

test('a bulk edit names what it changed, what failed and what it left out', () => {
  const results = [{ id: 1 }, { id: 2, error: 'linking #2 to #9 would make a cycle' }];
  const msg = bulkEditMessage('builds_on', results, [{ id: 3, reason: 'has started' }], '#9');
  assert.equal(msg, '1 now build on #9 · #2 failed: linking #2 to #9 would make a cycle · #3 left out: has started');
});
