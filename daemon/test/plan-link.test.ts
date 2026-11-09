// Which plan a task follows: its own, another task's, or none. Plain values, no database.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asTaskId } from './fixtures.ts';
import { checkoutOf } from '../src/domain/work/task/checkout.ts';
import { hasPlanLink, otherPlanOwner, planOwnerOf } from '../src/domain/work/plans/plan-link.ts';

const own = { id: asTaskId(5), plan: { task: asTaskId(5), steps: ['a'] } };
const following = { id: asTaskId(6), plan: { task: asTaskId(5), steps: null } };
const none = { id: asTaskId(7), plan: null };

test('planOwnerOf: the task whose plan this one follows, else itself', () => {
  assert.equal(planOwnerOf(own), 5);
  assert.equal(planOwnerOf(following), 5);
  assert.equal(planOwnerOf(none), 7);
});

test('otherPlanOwner: only a plan that belongs to another task', () => {
  assert.equal(otherPlanOwner(own), null, 'its own plan, given with --plan');
  assert.equal(otherPlanOwner(following), 5);
  assert.equal(otherPlanOwner(none), null);
});

test('hasPlanLink: a link to its own plan or another’s counts, no link does not', () => {
  assert.deepEqual([own, following, none].map(hasPlanLink), [true, true, false]);
});

test('checkoutOf: none when the branch, worktree and sync are all empty', () => {
  assert.equal(checkoutOf({ branch: null, worktree: null, syncing_since: null }), null);
  const only = { branch: 'agentdeck/task-1', worktree: null, syncing_since: null };
  assert.deepEqual(checkoutOf(only), only);
});
