// Moving the queue's selection with the arrow keys.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stepSelection } from '../../../../../app/src/lib/work/queue/selection.ts';

test('a move goes one row, and stops at the ends', () => {
  assert.equal(stepSelection([1, 2, 3], 2, 1), 3);
  assert.equal(stepSelection([1, 2, 3], 2, -1), 1);
  assert.equal(stepSelection([1, 2, 3], 3, 1), 3);
  assert.equal(stepSelection([1, 2, 3], 1, -1), 1);
});

test('nothing selected, or a selection no longer shown, starts at the first row', () => {
  assert.equal(stepSelection([4, 5], null, 1), 4);
  assert.equal(stepSelection([4, 5], null, -1), 4);
  assert.equal(stepSelection([4, 5], 9, 1), 4);
});

test('no rows select nothing', () => {
  assert.equal(stepSelection([], 1, 1), null);
});
