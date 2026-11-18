import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NOT_DRAINING, drainedMessage, inFlightLine, isDraining, mayStart } from '#domain/capacity/index.ts';
import { asRepoId } from '#domain/shared/index.ts';

const one = asRepoId(1);
const two = asRepoId(2);
const quiet = { runs: 0, retries: 0, planner: 0, follow_ups: 0, unblocks: 0, reviews: 0 };

test('isDraining: the daemon drains every repo, a repo drain only its own', () => {
  assert.equal(isDraining(NOT_DRAINING, one), false);
  assert.equal(isDraining({ daemon: true, repos: [] }, one), true);
  assert.equal(isDraining({ daemon: false, repos: [one] }, one), true);
  assert.equal(isDraining({ daemon: false, repos: [one] }, two), false);
});

test('mayStart: while draining only a task that has run before starts', () => {
  const d = { daemon: false, repos: [one] };
  assert.equal(mayStart(d, { repo_id: one, has_run: false }), false);
  assert.equal(mayStart(d, { repo_id: one, has_run: true }), true);
  assert.equal(mayStart(d, { repo_id: two, has_run: false }), true);
  assert.equal(mayStart({ daemon: true, repos: [] }, { repo_id: two, has_run: false }), false);
});

test('inFlightLine: null once nothing is in flight, else what is', () => {
  assert.equal(inFlightLine(quiet), null);
  assert.equal(inFlightLine({ ...quiet, runs: 2, retries: 1, reviews: 1 }), '2 runs, 1 retry, 1 review run');
  assert.equal(inFlightLine({ ...quiet, follow_ups: 3, unblocks: 1, planner: 1 }), '1 planner run, 3 follow-ups, 1 unblock run');
});

test('drainedMessage: names the scope and how to resume it', () => {
  assert.deepEqual(drainedMessage(null), {
    title: 'AgentDeck drained',
    body: 'Nothing is in flight; AgentDeck is paused. Run `agentdeck resume` to start work again.',
  });
  assert.match(drainedMessage('web').body, /web is paused\. Run `agentdeck repo resume web`/);
  assert.equal(drainedMessage('web').title, 'Drained web');
});
