// Pure tests of a task's target: the branch it starts from and lands on, and the builds-on links it allows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asRepoId, asTaskId } from '#domain/shared/index.ts';
import { type TargetEnd, buildsOnTargetError, missingTargetError, targetChangeError, targetOf } from '#domain/work/index.ts';

const repo = { base_branch: 'main' };

test('targetOf: a task lands on its own target, else on its repo’s base', () => {
  assert.equal(targetOf({ target: null }, repo), 'main');
  assert.equal(targetOf({ target: 'release' }, repo), 'release');
});

const end = (id: number | null, target: string | null, repo_id = 1, base_branch = 'main'): TargetEnd => ({
  id: id === null ? null : asTaskId(id),
  repo_id: asRepoId(repo_id),
  target,
  base_branch,
});

test('buildsOnTargetError: a builds-on link needs both tasks on the same target', () => {
  assert.equal(buildsOnTargetError(end(2, null), end(1, null)), null, 'both on the base');
  assert.equal(buildsOnTargetError(end(2, 'release'), end(1, 'release')), null, 'both on release');
  assert.equal(buildsOnTargetError(end(2, 'main'), end(1, null)), null, 'naming the base is the base');
  assert.equal(
    buildsOnTargetError(end(2, 'release'), end(1, null)),
    "#2 targets release and #1 targets main, so it can't build on it: give them the same target, or make it an after link instead",
  );
  assert.match(buildsOnTargetError(end(null, null), end(1, 'release')) ?? '', /^the new task targets main and #1 targets release/);
});

test('buildsOnTargetError: across repos, both must land on their own base', () => {
  assert.equal(buildsOnTargetError(end(2, null, 1, 'main'), end(1, null, 2, 'develop')), null);
  assert.match(buildsOnTargetError(end(2, null, 1, 'main'), end(1, 'release', 2, 'develop')) ?? '', /#1 targets release/);
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
