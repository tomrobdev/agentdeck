import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asTaskId } from '#domain/shared/index.ts';
import {
  type PlanBranchStatus,
  isWaitingToLand,
  planLandingOf,
  planLandingText,
  planPrBody,
  planPrMove,
  readyToLand,
  reviewVerdictOf,
} from '#domain/work/index.ts';

const merged = { status: 'done' as const, pr: { state: 'merged' as const, url: 'https://x/pull/1' } };
const open = { status: 'done' as const, pr: { state: 'open' as const, url: 'https://x/pull/2' } };
const cancelled = { status: 'cancelled' as const, pr: null };
const queued = { status: 'queued' as const, pr: null };
const active = { status: 'active' as const };

test('a plan branch is ready to land once every task on it is merged or cancelled, and one is merged', () => {
  assert.equal(readyToLand(active, [merged, merged, cancelled]), true);
  assert.equal(readyToLand(active, [merged]), true);
  assert.equal(readyToLand(active, [merged, open]), false, 'a PR still open');
  assert.equal(readyToLand(active, [merged, queued]), false, 'a task not done');
  assert.equal(readyToLand(active, [cancelled]), false, 'nothing merged');
  assert.equal(readyToLand(active, []), false);
  for (const status of ['open', 'conflict', 'landing', 'landed', 'abandoned'] as PlanBranchStatus[])
    assert.equal(readyToLand({ status }, [merged]), false, `a plan branch that is ${status}`);
});

test("a task's review verdict is its last submitted review's", () => {
  const r = (kind: 'comment' | 'request_changes' | null, submitted_at: string | null) => ({ kind, submitted_at });
  assert.equal(reviewVerdictOf([]), null);
  assert.equal(reviewVerdictOf([r(null, null)]), null, 'a draft is no verdict');
  assert.equal(reviewVerdictOf([r('request_changes', '1'), r('comment', '2')]), 'clean');
  assert.equal(reviewVerdictOf([r('comment', '1'), r('request_changes', '2'), r(null, null)]), 'blocking');
});

test("the plan PR's body is a punch list of the plan's tasks", () => {
  const body = planPrBody({ name: 'plan/7-payments', base: 'main', plan_task: asTaskId(7) }, 'Payments | phase', [
    { id: asTaskId(8), title: 'Pay out', ...merged, review: 'clean', unfinished: [] },
    { id: asTaskId(9), title: 'KYC', ...merged, review: null, unfinished: ['kyc', 'docs'] },
    { id: asTaskId(10), title: 'Drop it', ...cancelled, review: 'blocking', unfinished: [] },
  ]);
  assert.match(body, /^Lands `plan\/7-payments` on `main`: the work of #7's plan, Payments \\\| phase\./);
  assert.match(body, /\| #8 Pay out \| https:\/\/x\/pull\/1 \| clean \| none \|/);
  assert.match(body, /\| #9 KYC \| https:\/\/x\/pull\/1 \| not reviewed \| kyc, docs \|/);
  assert.match(body, /\| #10 Drop it \| cancelled \| blocking \| none \|/);
});

test('a plan PR that merged lands the plan branch, and one closed unmerged sends it back to active', () => {
  assert.equal(planPrMove('merged'), 'land');
  assert.equal(planPrMove('closed'), 'close_pr');
  assert.equal(planPrMove('open'), null);
  assert.equal(planPrMove('failed'), null);
});

test('a done task merged into a plan branch waits for it to land, then reads landed', () => {
  const task = { status: 'done' as const, pr: { state: 'merged' as const }, target: 'plan/7-payments' };
  const branch = (status: PlanBranchStatus) => ({ name: 'plan/7-payments', base: 'main', status });
  const waiting = planLandingOf(task, branch('landing'));
  assert.deepEqual(waiting, { name: 'plan/7-payments', base: 'main', state: 'waiting' });
  assert.equal(isWaitingToLand({ plan_landing: waiting }), true);
  assert.equal(planLandingText(waiting ?? assert.fail()), 'merged into plan/7-payments, waiting for it to land');

  const landed = planLandingOf(task, branch('landed'));
  assert.equal(isWaitingToLand({ plan_landing: landed }), false);
  assert.equal(planLandingText(landed ?? assert.fail()), 'landed on main with plan/7-payments');
  assert.equal(
    planLandingText(planLandingOf(task, branch('abandoned')) ?? assert.fail()),
    'merged into plan/7-payments, which was abandoned before it landed',
  );

  assert.equal(planLandingOf({ ...task, pr: { state: 'open' } }, branch('active')), null, 'not merged yet');
  assert.equal(planLandingOf({ ...task, target: null }, branch('active')), null, 'on the base');
  assert.equal(planLandingOf(task, undefined), null);
  assert.equal(isWaitingToLand({ plan_landing: null }), false);
});
