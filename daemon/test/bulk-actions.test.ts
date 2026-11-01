// What the bulk bar offers: the actions every selected task allows. The dashboard has no test runner, so it is tested here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bulkActions, idRange } from '../../app/src/lib/bulk.ts';

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

test('nothing selected offers nothing', () => {
  assert.deepEqual(bulkActions([]), []);
});

test('a shift-click range runs either way and falls back to the one row', () => {
  assert.deepEqual(idRange([1, 2, 3, 4], 2, 4), [2, 3, 4]);
  assert.deepEqual(idRange([1, 2, 3, 4], 4, 2), [2, 3, 4]);
  assert.deepEqual(idRange([1, 2, 3, 4], null, 3), [3]);
});
