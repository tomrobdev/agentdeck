// What the Changes tab derives from its files and comments.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { totalLines, visibleComments } from '#app/lib/work/files/changes-view.ts';

test('the lines of every file are added up', () => {
  assert.deepEqual(totalLines([]), { add: 0, del: 0 });
  assert.deepEqual(
    totalLines([
      { additions: 3, deletions: 1 },
      { additions: 2, deletions: 5 },
    ]),
    { add: 5, del: 6 },
  );
});

test('against the base every comment shows; since a point only the new side', () => {
  const list = [
    { id: 1, side: 'old' },
    { id: 2, side: 'new' },
  ];
  assert.deepEqual(visibleComments(list, false), list);
  assert.deepEqual(visibleComments(list, true), [{ id: 2, side: 'new' }]);
  assert.equal(visibleComments(undefined, true), undefined);
  assert.equal(visibleComments(undefined, false), undefined);
});
