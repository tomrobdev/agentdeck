// Moving through review: the next task in review after a merge, and the next file and open comment of a diff.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextInReview, openCommentOrder, stepFrom } from '../../app/src/lib/reviewNav.ts';

const task = (id: number, over: Record<string, unknown> = {}) =>
  ({ id, title: `t${id}`, status: 'done', pr_state: 'open', merge_request: null, sync: null, priority: 0, ...over }) as never;
const idOf = (t: { id: number } | null) => t?.id ?? null;

test('the next in review is the next row, never the current task', () => {
  assert.equal(idOf(nextInReview([task(1), task(2)], 1)), 2);
  assert.equal(idOf(nextInReview([task(1)], 1)), null);
});

test('a task that is not in review, or whose merge is requested, is skipped', () => {
  const order = [
    task(1),
    task(2, { merge_request: { verdict: 'wait' } }),
    task(3, { status: 'queued', pr_state: null }),
    task(4, { pr_state: 'merged' }),
    task(5),
  ];
  assert.equal(idOf(nextInReview(order, 1)), 5);
});

test('after the last row it goes round to the rows before the current one', () => {
  assert.equal(idOf(nextInReview([task(1), task(2), task(3)], 3)), 1);
  assert.equal(idOf(nextInReview([task(1), task(2)], 9)), 1);
});

test('stepFrom stops at the ends and starts from the first or last when nothing is current', () => {
  assert.equal(stepFrom(['a', 'b', 'c'], 'a', 1), 'b');
  assert.equal(stepFrom(['a', 'b', 'c'], 'c', 1), 'c');
  assert.equal(stepFrom(['a', 'b', 'c'], 'a', -1), 'a');
  assert.equal(stepFrom(['a', 'b', 'c'], null, 1), 'a');
  assert.equal(stepFrom(['a', 'b', 'c'], null, -1), 'c');
  assert.equal(stepFrom([], null, 1), null);
});

test('open comments run in the files order then by line, resolved ones left out', () => {
  const c = (id: number, path: string, line: number, state = 'open') => ({ id, path, line, state });
  const out = openCommentOrder(
    [c(1, 'b.ts', 3), c(2, 'a.ts', 9), c(3, 'a.ts', 2), c(4, 'a.ts', 1, 'resolved'), c(5, 'z.ts', 1)],
    ['a.ts', 'b.ts'],
  );
  assert.deepEqual(
    out.map((x) => x.id),
    [3, 2, 1],
  );
});
