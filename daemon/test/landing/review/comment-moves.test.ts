import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COMMENT_MOVES,
  COMMENT_STATES,
  commentActionError,
  commentStatesFor,
  nextCommentState,
} from '../../../src/domain/landing/review/review.ts';
import type { CommentAction, CommentState } from '../../../src/domain/landing/review/review.ts';

const TABLE: [CommentAction, CommentState, CommentState | null][] = [
  ['answer', 'open', 'answered'],
  ['answer', 'answered', 'answered'],
  ['answer', 'resolved', null],
  ['resolve', 'open', 'resolved'],
  ['resolve', 'answered', 'resolved'],
  ['resolve', 'resolved', null],
  ['reopen', 'open', null],
  ['reopen', 'answered', 'open'],
  ['reopen', 'resolved', 'open'],
];

test('COMMENT_MOVES has exactly the moves of the table', () => {
  const moves = Object.entries(COMMENT_MOVES).flatMap(([action, from]) => Object.entries(from).map(([state, to]) => [action, state, to]));
  assert.deepEqual(
    moves.sort(),
    TABLE.filter(([, , to]) => to !== null).sort(),
    'a move added to or dropped from COMMENT_MOVES is added to or dropped from the table here',
  );
  const actions = Object.keys(COMMENT_MOVES) as CommentAction[];
  assert.deepEqual(TABLE.length, actions.length * COMMENT_STATES.length, 'the table has one row for each action from each state');
});

for (const [action, from, to] of TABLE) {
  test(`${action} from ${from} ${to ? `leads to ${to}` : 'is refused'}`, () => {
    assert.equal(nextCommentState(from, action), to);
    assert.equal(commentStatesFor(action).includes(from), to !== null, 'the guard of the update allows exactly the moves');
    const error = commentActionError(from, action);
    if (to) assert.equal(error, null);
    else {
      assert.ok(error, 'a refused move says why');
      assert.match(error, new RegExp(`the comment is ${from}`));
      assert.match(error, action === 'reopen' ? /nothing to reopen/ : action === 'answer' ? /can't be answered/ : /can't be resolved/);
    }
  });
}
