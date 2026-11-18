// Pure tests of a plan branch: its rule table, a seeded walk through it, its name and which tasks move onto or off it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asTaskId } from '#domain/shared/index.ts';
import {
  type PlanBranchMove,
  type PlanBranchStatus,
  type PlanBranchTask,
  abandonRunningError,
  isLivePlanBranch,
  needsCut,
  nextPlanBranchStatus,
  planBranchMoveError,
  planBranchName,
  planBranchOpenError,
  planBranchStatusesFor,
  planBranchTarget,
  planBranchTargetChanges,
  tasksBackToBase,
  tasksToTarget,
} from '#domain/work/index.ts';

const STATUSES: PlanBranchStatus[] = ['open', 'active', 'conflict', 'landing', 'landed', 'abandoned', 'partly_landed'];
const MOVES: PlanBranchMove[] = ['cut', 'conflict', 'resolve', 'open_pr', 'close_pr', 'land', 'abandon'];

const EXPECTED: Record<PlanBranchMove, Partial<Record<PlanBranchStatus, PlanBranchStatus>>> = {
  cut: { open: 'active' },
  conflict: { active: 'conflict' },
  resolve: { conflict: 'active' },
  open_pr: { active: 'landing' },
  close_pr: { landing: 'active' },
  land: { landing: 'landed' },
  abandon: { open: 'abandoned', active: 'abandoned', conflict: 'abandoned', landing: 'abandoned' },
};

test('every move from every status goes where the rule table says, and nowhere else', () => {
  for (const move of MOVES) {
    for (const from of STATUSES) assert.equal(nextPlanBranchStatus(from, move), EXPECTED[move][from] ?? null, `${move} from ${from}`);
    assert.deepEqual(planBranchStatusesFor(move).sort(), Object.keys(EXPECTED[move]).sort());
  }
});

test('landed, abandoned and partly_landed are ends: no move leaves them', () => {
  for (const from of ['landed', 'abandoned', 'partly_landed'] as const) {
    for (const move of MOVES) assert.equal(nextPlanBranchStatus(from, move), null);
  }
});

function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

test('random move sequences never reach landed without passing landing', () => {
  for (let seed = 1; seed <= 500; seed++) {
    const random = seeded(seed);
    let status: PlanBranchStatus = 'open';
    const path: PlanBranchStatus[] = [status];
    for (let i = 0; i < 40; i++) {
      const next = nextPlanBranchStatus(status, MOVES[Math.floor(random() * MOVES.length)]);
      if (next === null) continue;
      if (next === 'landed') assert.equal(status, 'landing', `seed ${seed}: ${path.join(' → ')} → landed`);
      status = next;
      path.push(status);
    }
    if (status === 'landed') assert.ok(path.includes('landing'));
    assert.ok(!path.includes('partly_landed'), 'nothing reaches partly_landed in phase 1');
  }
});

test('a plan branch is named plan/<plan task>-<slug of the plan title>', () => {
  assert.equal(planBranchName(asTaskId(332), 'King of Comps: payments & KYC'), 'plan/332-king-of-comps-payments-kyc');
  assert.equal(planBranchName(asTaskId(7), ''), 'plan/7-plan');
});

test('a live plan branch is a target; a landed or abandoned one is not', () => {
  for (const status of ['open', 'active', 'conflict', 'landing'] as const) {
    assert.ok(isLivePlanBranch({ status }));
    assert.equal(planBranchTarget({ name: 'plan/1-x', status }), 'plan/1-x');
  }
  for (const status of ['landed', 'abandoned', 'partly_landed'] as const) {
    assert.ok(!isLivePlanBranch({ status }));
    assert.equal(planBranchTarget({ name: 'plan/1-x', status }), null);
  }
  assert.equal(planBranchTarget(undefined), null);
});

test('only an open plan branch needs cutting', () => {
  assert.ok(needsCut({ status: 'open' }));
  assert.ok(!needsCut({ status: 'active' }));
});

test('a move the table refuses names the branch and its status', () => {
  assert.equal(planBranchMoveError({ name: 'plan/1-x', status: 'open' }, 'abandon'), null);
  assert.equal(planBranchMoveError({ name: 'plan/1-x', status: 'landed' }, 'abandon'), "plan/1-x is landed, so it can't be abandoned");
  assert.equal(planBranchMoveError({ name: 'plan/1-x', status: 'open' }, 'open_pr'), "plan/1-x is open, so it can't open pr");
});

test('a plan has one plan branch per repo', () => {
  assert.equal(planBranchOpenError(asTaskId(3), undefined), null);
  assert.equal(
    planBranchOpenError(asTaskId(3), { name: 'plan/3-x', status: 'abandoned' }),
    "#3's plan has a plan branch already: plan/3-x (abandoned)",
  );
});

const task = (id: number, target: string | null, started = false, running = false): PlanBranchTask => ({
  id: asTaskId(id),
  target,
  started,
  running,
});

test('opening targets the tasks that name no target and have not started', () => {
  assert.deepEqual(tasksToTarget([task(1, null), task(2, 'release'), task(3, null, true), task(4, null)]), [asTaskId(1), asTaskId(4)]);
  assert.deepEqual(planBranchTargetChanges('plan/1-x'), { target: 'plan/1-x' });
  assert.deepEqual(planBranchTargetChanges(null), { target: null });
});

test('abandoning moves the tasks on it that have not started back to the base, and is refused while one runs', () => {
  const on = [task(1, 'plan/1-x'), task(2, 'plan/1-x', true), task(3, 'release'), task(4, 'plan/1-x')];
  assert.deepEqual(tasksBackToBase(on, 'plan/1-x'), [asTaskId(1), asTaskId(4)]);
  assert.equal(abandonRunningError('plan/1-x', on), null);
  assert.equal(abandonRunningError('plan/1-x', [task(5, 'plan/1-x', true, true)]), '#5 is running on plan/1-x; abandon it once it ends');
  assert.equal(
    abandonRunningError('plan/1-x', [task(5, 'plan/1-x', true, true), task(6, 'plan/1-x', true, true), task(7, 'other', true, true)]),
    '#5, #6 are running on plan/1-x; abandon it once they end',
  );
});
