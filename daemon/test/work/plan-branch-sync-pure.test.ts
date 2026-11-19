import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_PLAN_BRANCH_SYNC_MINUTES,
  type PlanBranchStatus,
  mayResolvePlanBranch,
  planBranchConflict,
  planBranchSyncDue,
  planBranchSyncMinutesError,
  planBranchSyncMove,
  planBranchWait,
  startWait,
} from '#domain/work/index.ts';
import { headline } from '#domain/operations/index.ts';
import { buildPlanResolvePrompt, buildResolvePrompt } from '#domain/runs/index.ts';
import { asTaskId } from '#domain/shared/index.ts';

const NOW = Date.parse('2026-11-19T12:00:00Z');

test('a plan branch is due for a sync once its last one is older than the setting, and only while active or in conflict', () => {
  const every = DEFAULT_PLAN_BRANCH_SYNC_MINUTES;
  assert.equal(every, 60);
  assert.equal(planBranchSyncDue({ status: 'active', synced_at: null }, NOW, every), true, 'never synced');
  assert.equal(planBranchSyncDue({ status: 'active', synced_at: '2026-11-19 11:30:00' }, NOW, every), false);
  assert.equal(planBranchSyncDue({ status: 'active', synced_at: '2026-11-19 11:00:00' }, NOW, every), true);
  assert.equal(planBranchSyncDue({ status: 'conflict', synced_at: '2026-11-19 10:00:00' }, NOW, every), true);
  for (const status of ['open', 'landing', 'landed', 'abandoned', 'partly_landed'] as PlanBranchStatus[])
    assert.equal(planBranchSyncDue({ status, synced_at: null }, NOW, every), false, status);
});

test('only an active plan branch in a repo with auto_resolve on gets a resolve run', () => {
  assert.equal(mayResolvePlanBranch({ status: 'active' }, { auto_resolve: true }), true);
  assert.equal(mayResolvePlanBranch({ status: 'active' }, { auto_resolve: false }), false);
  assert.equal(mayResolvePlanBranch({ status: 'conflict' }, { auto_resolve: true }), false, 'one failed resolve is enough');
});

test('a sync moves a plan branch into conflict when it fails, and out of it when it settles', () => {
  assert.equal(planBranchSyncMove({ status: 'active' }, 'conflict'), 'conflict');
  assert.equal(planBranchSyncMove({ status: 'conflict' }, 'conflict'), null);
  for (const outcome of ['up_to_date', 'clean', 'resolved'] as const) {
    assert.equal(planBranchSyncMove({ status: 'conflict' }, outcome), 'resolve', outcome);
    assert.equal(planBranchSyncMove({ status: 'active' }, outcome), null, outcome);
  }
});

test('the sync interval is from 5 minutes to a week', () => {
  assert.equal(planBranchSyncMinutesError(5), null);
  assert.equal(planBranchSyncMinutesError(10080), null);
  assert.match(planBranchSyncMinutesError(4) ?? '', /from 5 to 10080/);
  assert.match(planBranchSyncMinutesError(10081) ?? '', /from 5 to 10080/);
});

test('a task targeting a plan branch in conflict waits for it, after its dependencies and before its slot', () => {
  const branch = { name: 'plan/7-pay', base: 'main', status: 'conflict' as const };
  assert.deepEqual(planBranchWait(branch), { name: 'plan/7-pay', base: 'main' });
  assert.equal(planBranchWait({ ...branch, status: 'active' }), null);
  assert.equal(planBranchWait(undefined), null);
  const ctx = {
    queue: null,
    repoPaused: null,
    draining: null,
    dependency: { kind: 'none' } as const,
    planBranch: planBranchWait(branch),
    unblocking: true,
    running: 2,
    max: 2,
  };
  assert.deepEqual(startWait({ status: 'queued' }, ctx), { kind: 'plan-branch', name: 'plan/7-pay', base: 'main' });
  assert.equal(startWait({ status: 'queued' }, { ...ctx, dependency: { kind: 'waiting', on: [asTaskId(3)] } })?.kind, 'dependency');
  assert.equal(startWait({ status: 'running' }, ctx), null);
});

test('attention lists a plan branch in conflict, with what a person does about it', () => {
  const conflict = planBranchConflict({ name: 'plan/7-pay', base: 'main' }, 'shop');
  assert.equal(conflict.repo, 'shop');
  assert.match(conflict.line, /plan\/7-pay conflicts with main.*a merge of main into it is pushed/);
  const facts = {
    paused: false,
    rate_limited_until: null,
    governor: { allow: true, until: null },
    running: 0,
    need_you: { proposed: 0, blocked: 0, review: 0 },
    attention: [],
  };
  assert.deepEqual(headline({ ...facts, plan_branches: [conflict] }, 0).plan_branches, [conflict]);
  assert.deepEqual(headline(facts, 0).plan_branches, []);
});

test('a plan branch’s resolve prompt names the plan branch and the plan, where a task’s names the task', () => {
  const plan = { id: asTaskId(7), title: 'Payments', prompt: 'Pin the payment code.' };
  const ctx = { base: 'main', files: ['pay.ts'], ours: ['plan work'], theirs: ['base work'], testCmd: 'pnpm test' };
  const text = buildPlanResolvePrompt(plan, 'plan/7-payments', ctx);
  assert.match(text, /^AgentDeck conflict resolution for plan branch plan\/7-payments \(the plan of task #7: "Payments"\)\./);
  assert.match(text, /merging `main` into the plan branch `plan\/7-payments`/);
  assert.match(text, /The plan's goal \(what this branch is for\):\nPin the payment code\./);
  assert.match(text, /- pay\.ts/);
  assert.match(
    buildResolvePrompt(plan, ctx),
    /^AgentDeck conflict resolution for task #7: "Payments"\.\n\nAgentDeck is merging `main` into this task's branch/,
  );
});
