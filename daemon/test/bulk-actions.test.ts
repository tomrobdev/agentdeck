// What the bulk bar offers: the actions every selected task allows. The dashboard has no test runner, so it is tested here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildsOnChain,
  bulkActions,
  bulkMessage,
  idRange,
  keepPicked,
  mergeAllIds,
  pickAll,
  summarizeBulk,
  toggleGroupPicks,
} from '../../app/src/lib/bulk.ts';

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
  // A collapsed group's rows are still in the filtered set, so its picks stay.
  assert.deepEqual(keepPicked([1, 2, 3], [1, 2, 3, 4]), [1, 2, 3]);
  assert.deepEqual(keepPicked([1, 2, 3], [1, 3]), [1, 3]);
});

test('a shift-click range runs either way and falls back to the one row', () => {
  assert.deepEqual(idRange([1, 2, 3, 4], 2, 4), [2, 3, 4]);
  assert.deepEqual(idRange([1, 2, 3, 4], 4, 2), [2, 3, 4]);
  assert.deepEqual(idRange([1, 2, 3, 4], null, 3), [3]);
});
