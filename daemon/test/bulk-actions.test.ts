// What the bulk bar offers: the actions every selected task allows. The dashboard has no test runner, so it is tested here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bulkActions, idRange, mergeAllIds } from '../../app/src/lib/bulk.ts';

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

test('a shift-click range runs either way and falls back to the one row', () => {
  assert.deepEqual(idRange([1, 2, 3, 4], 2, 4), [2, 3, 4]);
  assert.deepEqual(idRange([1, 2, 3, 4], 4, 2), [2, 3, 4]);
  assert.deepEqual(idRange([1, 2, 3, 4], null, 3), [3]);
});
