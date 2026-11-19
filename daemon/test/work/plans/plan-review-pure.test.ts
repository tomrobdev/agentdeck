import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type PrDetails, planPrCheck } from '#domain/landing/index.ts';
import { buildPlanReviewPrompt, planReviewComment, planReviewSystemPrompt, reviewVerdict } from '#domain/runs/index.ts';
import { asTaskId } from '#domain/shared/index.ts';
import {
  type PlanReviewState,
  nextPlanReviewState,
  planReviewDue,
  planReviewMoveOf,
  planReviewReasons,
  planReviewStatesFor,
} from '#domain/work/index.ts';

const pr: PrDetails = {
  state: 'open',
  draft: false,
  mergeable: 'MERGEABLE',
  merge_state: 'CLEAN',
  body: '',
  commits: 1,
  files: 1,
  additions: 1,
  deletions: 0,
  checks: { total: 1, failing: 0, pending: 0 },
  check_list: [],
  head: 'abc',
  merge_commit: null,
  paths: [],
  labels: [],
};

test('a plan review moves only from due, to the state its verdict names', () => {
  assert.equal(nextPlanReviewState('due', 'clean'), 'clean');
  assert.equal(nextPlanReviewState('due', 'block'), 'blocking');
  assert.equal(nextPlanReviewState('due', 'fail'), 'failed');
  for (const from of ['clean', 'blocking', 'failed'] as PlanReviewState[]) assert.equal(nextPlanReviewState(from, 'clean'), null);
  assert.deepEqual(planReviewStatesFor('block'), ['due']);
  assert.equal(planReviewMoveOf('clean'), 'clean');
  assert.equal(planReviewMoveOf('blocking'), 'block');
  assert.equal(planReviewMoveOf(null), 'fail');
});

test('a plan review is due only for a landing plan branch with an open plan PR it has not read', () => {
  const landing = { status: 'landing' as const, pr_url: 'https://example.test/pull/1', review: 'due' as const };
  assert.equal(planReviewDue(landing), true);
  assert.equal(planReviewDue({ ...landing, review: 'clean' }), false);
  assert.equal(planReviewDue({ ...landing, pr_url: null }), false);
  assert.equal(planReviewDue({ ...landing, status: 'active' }), false);
});

test('an auto plan PR waits for its plan review, needs a person when it blocks or failed, and merges when it is clean or predates plan reviews', () => {
  const verdict = (review: PlanReviewState | null) => planPrCheck(pr, null, planReviewReasons({ review })).verdict;
  assert.equal(verdict('due'), 'wait');
  assert.equal(verdict('blocking'), 'never');
  assert.equal(verdict('failed'), 'never');
  assert.equal(verdict('clean'), 'merge');
  assert.equal(verdict(null), 'merge');
  assert.match(planPrCheck(pr, null, planReviewReasons({ review: 'blocking' })).reasons[0]?.text ?? '', /blocking finding/);
});

test("the plan review prompt names the plan branch, every plan step with its done criteria, the tasks on it and the diff's range", () => {
  const html = `<html data-agentdeck-plan="1"><head><title>Pay</title></head><body>
<section data-plan-step id="a" data-status="done"><h2>Ledger</h2><ul data-plan-done><li>payouts are in the ledger</li></ul></section>
<section data-plan-step id="b" data-status="todo"><h2>Refunds</h2></section></body></html>`;
  const prompt = buildPlanReviewPrompt(
    { name: 'plan/7-pay', base: 'main', plan_task: asTaskId(7) },
    { plan: { name: '7-pay.html', html }, tasks: [{ id: asTaskId(8), title: 'ledger', status: 'done' }], from: 'f1', head: 'h2' },
  );
  assert.match(prompt, /plan review run for plan\/7-pay, the plan branch of #7's plan, before it lands on main/);
  assert.match(prompt, /Step "a": Ledger \(status: done\)\n[\s\S]*- payouts are in the ledger/);
  assert.match(prompt, /Step "b": Refunds/);
  assert.match(prompt, /- #8 ledger \(done\)/);
  assert.match(prompt, /git diff f1 h2/);
  assert.match(
    buildPlanReviewPrompt({ name: 'p', base: 'main', plan_task: asTaskId(7) }, { plan: null, tasks: [], from: 'a', head: 'b' }),
    /no page/,
  );
  assert.match(planReviewSystemPrompt(), /plan review run/);
});

test("a plan review's comment on the plan PR gives its verdict, summary and findings", () => {
  const answer = {
    summary: 'Mostly there.',
    findings: [{ path: 'a.ts', line: 3, side: 'new' as const, body: 'refunds missing', blocking: true }],
  };
  assert.equal(reviewVerdict(answer), 'blocking');
  assert.equal(
    planReviewComment(answer),
    '**AgentDeck plan review**, blocking: this plan PR must not land as it is.\n\nMostly there.\n\n- **Blocking** `a.ts:3`: refunds missing',
  );
  assert.equal(planReviewComment({ summary: 'Fine.', findings: [] }), '**AgentDeck plan review**, clean: no finding blocks.\n\nFine.');
});
