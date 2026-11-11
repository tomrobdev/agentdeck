import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MERGE_REQUEST_MOVES,
  MERGE_REQUEST_STATES,
  mergeRequestStateOf,
  mergeRequestStatesFor,
  nextMergeRequestState,
} from '#domain/landing/merge/merge-request.ts';
import type { MergeRequestMove, MergeRequestState } from '#domain/landing/merge/merge-request.ts';

const MOVES: [MergeRequestMove, MergeRequestState, MergeRequestState][] = [
  ['asked', 'none', 'requested'],
  ['asked', 'requested', 'requested'],
  ['carried_out', 'requested', 'none'],
  ['dropped', 'requested', 'none'],
  ['refused', 'requested', 'none'],
];

test('MERGE_REQUEST_MOVES has exactly the moves listed here', () => {
  const moves = Object.entries(MERGE_REQUEST_MOVES).flatMap(([move, from]) => Object.entries(from).map(([state, to]) => [move, state, to]));
  assert.deepEqual(moves.sort(), [...MOVES].sort(), 'a move added to or dropped from the table is added to or dropped from the list here');
});

for (const [move, from, to] of MOVES) {
  test(`a merge request ${move} from ${from} goes to ${to}`, () => {
    assert.equal(nextMergeRequestState(from, move), to);
    assert.ok(mergeRequestStatesFor(move).includes(from), 'the guard of the write allows the move');
  });
}

test('a move the table does not allow has no next state, and the guard of the write leaves it out', () => {
  const allowed = new Set(MOVES.map(([move, from]) => `${move} ${from}`));
  for (const move of Object.keys(MERGE_REQUEST_MOVES) as MergeRequestMove[]) {
    for (const from of MERGE_REQUEST_STATES) {
      if (allowed.has(`${move} ${from}`)) continue;
      assert.equal(nextMergeRequestState(from, move), null, `${move} from ${from}`);
      assert.ok(!mergeRequestStatesFor(move).includes(from), `${move} from ${from}`);
    }
  }
  assert.equal(nextMergeRequestState('none', 'dropped'), null, 'there is no request to drop');
});

test("a task's merge request state is whether its PR has one", () => {
  assert.equal(mergeRequestStateOf(null), 'none');
  assert.equal(mergeRequestStateOf({ merge_request: null }), 'none');
  assert.equal(mergeRequestStateOf({ merge_request: { requested_at: '2026-11-11 10:00:00', method: null, check: null } }), 'requested');
});
