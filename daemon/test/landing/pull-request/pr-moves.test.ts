import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PR_FROM, PR_MOVES, nextPrState, prFrom, prStatesFor, seenMove } from '#domain/landing/pull-request/pr-moves.ts';
import type { PrFrom, PrMove } from '#domain/landing/pull-request/pr-moves.ts';
import type { PrState } from '#domain/landing/index.ts';
import { prMoveOf } from '#domain/work/index.ts';

const MOVES: [PrMove, PrFrom, PrState][] = [
  ['opened', 'none', 'open'],
  ['opened', 'merged', 'open'],
  ['opened', 'closed', 'open'],
  ['opened', 'failed', 'open'],
  ['merged', 'open', 'merged'],
  ['closed', 'open', 'closed'],
  ['open_failed', 'none', 'failed'],
  ['open_failed', 'merged', 'failed'],
  ['open_failed', 'closed', 'failed'],
  ['open_failed', 'failed', 'failed'],
];

test('PR_MOVES has exactly the moves listed here', () => {
  const moves = Object.entries(PR_MOVES).flatMap(([move, from]) => Object.entries(from).map(([state, to]) => [move, state, to]));
  assert.deepEqual(moves.sort(), [...MOVES].sort(), 'a move added to or dropped from PR_MOVES is added to or dropped from the list here');
});

for (const [move, from, to] of MOVES) {
  test(`a PR ${move} from ${from} goes to ${to}`, () => {
    assert.equal(nextPrState(from, move), to);
    assert.ok(prStatesFor(move).includes(from), 'the guard of the write allows the move');
  });
}

test('a move the table does not allow has no next state, and the guard of the write leaves it out', () => {
  const allowed = new Set(MOVES.map(([move, from]) => `${move} ${from}`));
  for (const move of Object.keys(PR_MOVES) as PrMove[]) {
    for (const from of PR_FROM) {
      if (allowed.has(`${move} ${from}`)) continue;
      assert.equal(nextPrState(from, move), null, `${move} from ${from}`);
      assert.ok(!prStatesFor(move).includes(from), `${move} from ${from}`);
    }
  }
  assert.equal(nextPrState('closed', 'reopened'), null, 'a closed PR seen open again is ignored');
  assert.deepEqual(prStatesFor('reopened'), []);
});

test('a task with no PR moves from none', () => {
  assert.equal(prFrom(null), 'none');
  assert.equal(prFrom(undefined), 'none');
  assert.equal(prFrom('open'), 'open');
});

test('what GitHub reports and what the daemon records are each one move', () => {
  assert.equal(seenMove('open'), 'reopened');
  assert.equal(seenMove('merged'), 'merged');
  assert.equal(seenMove('closed'), 'closed');
  assert.equal(seenMove('failed'), 'open_failed');
  assert.equal(prMoveOf({ type: 'opened', url: 'https://x/pull/1' }), 'opened');
  assert.equal(prMoveOf({ type: 'failed', error: 'no' }), 'open_failed');
  assert.equal(prMoveOf({ type: 'closed' }), 'closed');
  assert.equal(prMoveOf({ type: 'seen', state: 'merged' }), 'merged');
});
