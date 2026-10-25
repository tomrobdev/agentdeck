// Which drop on the board means which lifecycle event. The dashboard has no test runner, so its move rule is tested here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardMove, statusGroup } from '../../app/src/boardMove.ts';

const task = (status: string, extra: Record<string, unknown> = {}) => ({ id: 1, status, pr_state: null, waiting: null, ...extra }) as never;

test('a blocked or failed task dropped on Done is marked done', () => {
  assert.equal(boardMove(task('blocked'), 'done'), 'mark_done');
  assert.equal(boardMove(task('failed'), 'done'), 'mark_done');
});

test('no other task moves to Done by a drop', () => {
  assert.equal(boardMove(task('queued'), 'done'), null);
  assert.equal(boardMove(task('proposed'), 'done'), null);
  assert.equal(boardMove(task('cancelled'), 'done'), null);
  assert.equal(boardMove(task('running'), 'done'), null);
  assert.equal(boardMove(task('queued', { waiting: { on: 2, stuck: 'cancelled' } }), 'done'), null);
});

test('the other moves are unchanged', () => {
  assert.equal(boardMove(task('blocked'), 'queued'), 'retry');
  assert.equal(boardMove(task('failed'), 'cancelled'), 'cancel');
  assert.equal(boardMove(task('proposed'), 'queued'), 'approve');
});

test('every finished task is in Done, whatever its PR; an open PR is in Review', () => {
  assert.equal(statusGroup(task('done', { pr_state: 'merged', pr_url: 'u' })), 'done');
  assert.equal(statusGroup(task('done', { pr_state: 'closed', pr_url: 'u' })), 'done');
  assert.equal(statusGroup(task('done')), 'done');
  assert.equal(statusGroup(task('done', { pr_state: 'open', pr_url: 'u' })), 'review');
});
