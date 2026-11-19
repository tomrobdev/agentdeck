// Pure tests of a task's target: the branch it starts from and lands on, and the builds-on links it allows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asRepoId, asTaskId } from '#domain/shared/index.ts';
import {
  type PlanBranchStatus,
  type TargetEnd,
  buildsOnTargetError,
  missingTargetError,
  placeAt,
  targetChangeError,
  targetOf,
} from '#domain/work/index.ts';

const repo = { base_branch: 'main' };

test('targetOf: a task lands on its own target, else on its repo’s base', () => {
  assert.equal(targetOf({ target: null }, repo), 'main');
  assert.equal(targetOf({ target: 'release' }, repo), 'release');
});

const end = (
  id: number | null,
  target: string | null,
  repo_id = 1,
  base_branch = 'main',
  plan_branch: PlanBranchStatus | null = null,
): TargetEnd => ({
  id: id === null ? null : asTaskId(id),
  repo_id: asRepoId(repo_id),
  target,
  base_branch,
  plan_branch,
});

test('buildsOnTargetError: a builds-on link is refused only when the work it builds on never reaches the task', () => {
  assert.equal(buildsOnTargetError(end(2, null), end(1, null)), null, 'both on the base');
  assert.equal(buildsOnTargetError(end(2, 'release'), end(1, 'release')), null, 'both on release');
  assert.equal(buildsOnTargetError(end(2, 'main'), end(1, null)), null, 'naming the base is the base');
  assert.equal(
    buildsOnTargetError(end(2, 'release'), end(1, null)),
    "#2 targets release and #1 targets main, whose work never reaches it, so it can't build on it: give them the same target, or make it an after link instead",
  );
  assert.match(buildsOnTargetError(end(null, null), end(1, 'release')) ?? '', /^the new task targets main and #1 targets release/);
});

test('buildsOnTargetError: a plan branch lands on the base and keeps up with it, so either side may be on one', () => {
  assert.equal(buildsOnTargetError(end(2, null), end(1, 'plan/9-x', 1, 'main', 'active')), null, 'the plan branch lands on the base');
  assert.equal(buildsOnTargetError(end(2, 'plan/9-x', 1, 'main', 'open'), end(1, null)), null, 'the base syncs into it');
  assert.equal(buildsOnTargetError(end(2, 'plan/9-x', 1, 'main', 'open'), end(1, 'plan/9-x', 1, 'main', 'open')), null);
  assert.match(buildsOnTargetError(end(2, null), end(1, 'plan/9-x', 1, 'main', 'abandoned')) ?? '', /never reaches it/);
  assert.match(buildsOnTargetError(end(2, 'release'), end(1, 'plan/9-x', 1, 'main', 'active')) ?? '', /never reaches it/);
});

test('buildsOnTargetError: across repos, every base is one place and a plan branch name is one place', () => {
  assert.equal(buildsOnTargetError(end(2, null, 1, 'main'), end(1, null, 2, 'develop')), null);
  assert.match(buildsOnTargetError(end(2, null, 1, 'main'), end(1, 'release', 2, 'develop')) ?? '', /#1 targets release/);
  assert.equal(buildsOnTargetError(end(2, 'plan/9-x', 1, 'main', 'open'), end(1, 'plan/9-x', 2, 'develop', 'open')), null);
  assert.equal(buildsOnTargetError(end(2, null, 1, 'main'), end(1, 'plan/9-x', 2, 'develop', 'active')), null);
});

test('placeAt: a target naming the base is the base, and only another branch keeps its plan branch', () => {
  assert.deepEqual(placeAt(null, 'main', null), { target: null, plan_branch: null });
  assert.deepEqual(placeAt('main', 'main', 'active'), { target: null, plan_branch: null });
  assert.deepEqual(placeAt('plan/9-x', 'main', 'landed'), { target: 'plan/9-x', plan_branch: 'landed' });
});

test('targetChangeError: a target is fixed once the task has a branch', () => {
  assert.equal(targetChangeError({ id: asTaskId(3), checkout: null }), null);
  assert.equal(targetChangeError({ id: asTaskId(3), checkout: { branch: null } }), null);
  assert.equal(
    targetChangeError({ id: asTaskId(3), checkout: { branch: 'agentdeck/task-3' } }),
    "#3 has a branch already (agentdeck/task-3), so its target can't change",
  );
});

test('missingTargetError names the branch looked for, locally and on origin', () => {
  assert.equal(missingTargetError('release'), "no branch release locally or as origin/release, so it can't be a target");
});
