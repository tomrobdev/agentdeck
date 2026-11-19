import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type MergeFailure, type PrDetails, planPrCheck } from '#domain/landing/index.ts';
import {
  DEFAULT_LANDING_POLICY,
  LANDING_ANSWERS,
  LANDING_POLICIES,
  type LandingBranch,
  type LandingPolicy,
  type PlanBranchStatus,
  afterLandingMerge,
  afterPlanPrState,
  isLandingAnswer,
  isLandingPolicy,
  landingAnswerMove,
  landingOrder,
  landingOrderError,
  landingQuestion,
  nextLandingStep,
  nextPlanBranchStatus,
  partlyLandedLine,
  planBranchWait,
  planBranchWaitText,
  revertFrom,
} from '#domain/work/index.ts';

const branch = (id: number, o: Partial<LandingBranch> = {}): LandingBranch => ({
  id,
  name: 'plan/7-pay',
  repo: `repo-${id}`,
  status: 'landing',
  land_order: null,
  land_error: null,
  verdict: 'merge',
  reason: null,
  ...o,
});

test('the landing policies, and a person lands a plan unless it says otherwise', () => {
  assert.equal(DEFAULT_LANDING_POLICY, 'person');
  assert.deepEqual(LANDING_POLICIES, ['person', 'auto', 'together', 'in_order']);
  assert.ok(isLandingPolicy('in_order'));
  assert.ok(!isLandingPolicy('sometimes'));
  assert.deepEqual(LANDING_ANSWERS, ['retry', 'revert', 'by_hand']);
  assert.ok(isLandingAnswer('revert'));
  assert.ok(!isLandingAnswer('shrug'));
});

test('a person policy never merges; auto merges any plan PR whose check passes', () => {
  assert.deepEqual(nextLandingStep('person', [branch(1), branch(2)]), { kind: 'none' });
  assert.deepEqual(nextLandingStep('auto', [branch(1, { verdict: 'wait' }), branch(2)]), { kind: 'merge', branch: 2 });
  assert.deepEqual(nextLandingStep('auto', [branch(1, { verdict: 'wait' })]), { kind: 'none' });
});

test('together merges none until every plan PR is ready, then the rest even if one waits', () => {
  const step = nextLandingStep('together', [branch(1), branch(2, { verdict: 'wait', reason: 'checks pending' })]);
  assert.deepEqual(step, { kind: 'wait', reason: 'plan/7-pay in repo-2 waits: checks pending' });
  assert.deepEqual(nextLandingStep('together', [branch(1), branch(2)]), { kind: 'merge', branch: 1 });
  assert.deepEqual(nextLandingStep('together', [branch(1, { status: 'landed' }), branch(2, { verdict: 'wait' })]).kind, 'wait');
});

test('in_order merges the lowest land_order first, and a lasting failure after a landing stops the saga', () => {
  const order = [branch(1, { land_order: 1 }), branch(2, { land_order: 0, verdict: 'wait', reason: 'checks pending' })];
  assert.equal(nextLandingStep('in_order', order).kind, 'wait');
  assert.deepEqual(
    landingOrder(order).map((b) => b.id),
    [2, 1],
  );
  const failed = [branch(2, { status: 'landed', land_order: 0 }), branch(1, { land_order: 1, verdict: 'never', reason: 'CI failed' })];
  assert.deepEqual(nextLandingStep('in_order', failed), {
    kind: 'fail',
    branch: 1,
    error: 'plan/7-pay in repo-1 needs a person: CI failed',
  });
  const partly = [branch(2, { status: 'landed' }), branch(1, { status: 'partly_landed' })];
  assert.equal(nextLandingStep('in_order', partly).kind, 'wait');
});

test('a merge result and a PR state settle one plan branch', () => {
  const two = [
    { id: 1, status: 'landed' as PlanBranchStatus },
    { id: 2, status: 'landing' as PlanBranchStatus },
  ];
  assert.deepEqual(afterLandingMerge('in_order', two, 2, { merged: true }), { move: 'land', land_error: null });
  assert.deepEqual(afterLandingMerge('in_order', two, 2, { failure: 'transient', error: 'x' }), { move: null, land_error: null });
  assert.deepEqual(afterLandingMerge('in_order', two, 2, { failure: 'lasting', error: 'x' }), { move: 'part_land', land_error: 'x' });
  assert.deepEqual(afterLandingMerge('auto', two, 2, { failure: 'lasting', error: 'x' }), { move: null, land_error: 'x' });
  assert.deepEqual(afterPlanPrState('together', two, 2, 'closed'), { move: 'part_land', land_error: 'its plan PR was closed unmerged' });
  assert.deepEqual(afterPlanPrState('person', two, 2, 'closed'), { move: 'close_pr', land_error: null });
  assert.equal(afterPlanPrState('person', two, 2, 'open'), null);
  assert.equal(afterPlanPrState('in_order', [{ id: 2, status: 'partly_landed' }], 2, 'closed'), null);
});

test('a partly landed plan asks a question with three answers, and each answer is a move', () => {
  const branches = [branch(1, { status: 'landed' }), branch(2, { status: 'partly_landed', land_error: 'CI failed' })];
  const q = landingQuestion(branches);
  assert.match(q?.text ?? '', /landed in repo-1 but not in repo-2 \(CI failed\)/);
  assert.deepEqual(
    q?.options.map((o) => o.answer),
    ['retry', 'revert', 'by_hand'],
  );
  assert.equal(landingQuestion([branch(1)]), null);
  assert.match(partlyLandedLine(branches, 7), /agentdeck plan-branch answer 7/);
  assert.equal(partlyLandedLine([branch(1)], 7), "#7's plan landed in only some repos");
  assert.equal(landingAnswerMove('retry'), 'retry');
  assert.equal(landingAnswerMove('by_hand'), 'by_hand');
  assert.equal(landingAnswerMove('revert'), 'abandon');
});

test('an order names only repos the plan has a plan branch in, each once', () => {
  assert.equal(landingOrderError(['a', 'b'], ['a', 'b']), null);
  assert.match(landingOrderError(['c'], ['a', 'b']) ?? '', /no plan branch in c/);
  assert.equal(landingOrderError(['a', 'a'], ['a', 'b']), 'a repo is named twice in the order');
});

test('a revert goes back to the base before the landing: the first parent, or past every rebased commit', () => {
  assert.equal(revertFrom('abc', 'squash', 3), 'abc^1');
  assert.equal(revertFrom('abc', 'merge', 3), 'abc^1');
  assert.equal(revertFrom('abc', 'rebase', 3), 'abc~3');
  assert.equal(revertFrom('abc', 'rebase', 0), 'abc~1');
});

test("a task on a plan branch waits while it conflicts, or while any of its plan's plan branches is partly landed", () => {
  const b = { name: 'plan/7-pay', base: 'main', status: 'active' as PlanBranchStatus };
  assert.equal(planBranchWait(b, [{ status: 'landed' }]), null);
  const partly = planBranchWait(b, [{ status: 'partly_landed' }]);
  assert.deepEqual(partly, { name: 'plan/7-pay', base: 'main', status: 'partly_landed' });
  assert.match(planBranchWaitText(partly ?? assert.fail()), /partly landed/);
  assert.equal(planBranchWaitText({ name: 'plan/7-pay', base: 'main', status: 'conflict' }), 'plan/7-pay conflicts with main');
});

test("a plan PR's check is the unattended verdict, and a paused repo waits", () => {
  const pr: PrDetails = {
    state: 'open',
    mergeable: 'MERGEABLE',
    merge_state: 'CLEAN',
    draft: false,
    commits: 1,
    additions: 1,
    deletions: 0,
    files: 1,
    checks: { total: 1, failing: 0, pending: 0 },
    paths: [],
    labels: [],
  };
  assert.equal(planPrCheck(pr, null).verdict, 'merge');
  assert.equal(planPrCheck({ ...pr, checks: { total: 1, failing: 1, pending: 0 } }, null).verdict, 'never');
  assert.equal(planPrCheck(pr, 'paused by hand').verdict, 'wait');
});

function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

const VERDICTS: LandingBranch['verdict'][] = ['merge', 'merge', 'wait', 'never'];
const RESULTS: ({ merged: true } | { failure: MergeFailure; error: string })[] = [
  { merged: true },
  { merged: true },
  { failure: 'transient', error: 'GitHub timed out' },
  { failure: 'lasting', error: 'branch protection refused it' },
];

test('over random merge results across two or three repos, nothing lands before its policy allows, and every partly_landed state has a question', () => {
  for (let seed = 1; seed <= 2000; seed++) {
    const random = seeded(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)] as T;
    const policy: LandingPolicy = pick(LANDING_POLICIES);
    const count = 2 + Math.floor(random() * 2);
    let branches = Array.from({ length: count }, (_, i) =>
      branch(i + 1, { land_order: random() < 0.7 ? Math.floor(random() * 3) : null, verdict: pick(VERDICTS) }),
    );
    const trail: string[] = [policy];
    const set = (id: number, change: { move: Parameters<typeof nextPlanBranchStatus>[1] | null; land_error: string | null }) => {
      branches = branches.map((b) => {
        if (b.id !== id) return b;
        const status = change.move ? nextPlanBranchStatus(b.status, change.move) : b.status;
        return { ...b, status: status ?? b.status, land_error: change.land_error };
      });
    };
    for (let i = 0; i < 30; i++) {
      branches = branches.map((b) => (b.status === 'landing' && random() < 0.3 ? { ...b, verdict: pick(VERDICTS) } : b));
      const step = nextLandingStep(policy, branches);
      trail.push(`${step.kind}${'branch' in step ? step.branch : ''}`);
      const why = `seed ${seed}: ${trail.join(' → ')}`;
      if (step.kind === 'merge') {
        const target = branches.find((b) => b.id === step.branch) ?? assert.fail(why);
        assert.notEqual(policy, 'person', why);
        assert.equal(target.status, 'landing', why);
        assert.equal(target.verdict, 'merge', why);
        const left = branches.filter((b) => b.status !== 'landed' && b.status !== 'abandoned');
        if (policy === 'together' && !branches.some((b) => b.status === 'landed'))
          assert.ok(
            left.every((b) => b.status === 'landing' && b.verdict === 'merge' && b.land_error === null),
            `${why}: together merged before all were ready`,
          );
        if (policy === 'in_order') assert.equal(landingOrder(left)[0]?.id, target.id, `${why}: in_order merged out of order`);
        set(target.id, afterLandingMerge(policy, branches, target.id, pick(RESULTS)));
      } else if (step.kind === 'fail') {
        assert.ok(policy === 'together' || policy === 'in_order', why);
        set(step.branch, { move: 'part_land', land_error: step.error });
      } else if (random() < 0.2) {
        const partly = branches.find((b) => b.status === 'partly_landed');
        if (partly) set(partly.id, { move: landingAnswerMove(pick(['retry', 'by_hand'] as const)), land_error: null });
      }
      for (const b of branches) {
        if (b.status !== 'partly_landed') continue;
        assert.ok(landingQuestion(branches), `${why}: partly_landed without a question`);
        assert.ok(
          branches.some((o) => o.status === 'landed'),
          `${why}: partly_landed with nothing landed`,
        );
      }
    }
  }
});
