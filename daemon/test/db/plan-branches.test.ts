// The plan branch store: its guarded moves, the targets it sets and clears, and its rows going with their repo.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const { openDb } = await import('#db/index.ts');
const db = openDb(':memory:');
after(() => db.close());

const repo = db.addRepo({ name: 'r', path: '/tmp/plan-branches-r', base_branch: 'main' });

test('a move the rule table refuses, or on no such plan branch, changes nothing', () => {
  const owner = db.addTask({ repo_id: repo.id, title: 'plan', prompt: 'p', status: 'proposed' });
  const { opened, targeted } = db.openPlanBranch({ plan_task: owner.id, repo_id: repo.id, name: 'plan/1-x', base: 'main' }, []);
  assert.deepEqual(targeted, []);
  assert.equal(db.cutPlanBranch(opened.id + 1000, 'abc'), undefined);
  assert.equal(db.cutPlanBranch(opened.id, 'abc')?.status, 'active');
  assert.equal(db.cutPlanBranch(opened.id, 'def'), undefined);
  assert.equal(db.planBranchOf(owner.id, repo.id)?.head_commit, 'abc');

  const first = db.abandonPlanBranch(opened);
  assert.ok(first && 'abandoned' in first);
  assert.deepEqual(first.moved, []);
  assert.equal(db.abandonPlanBranch(opened), undefined);
});

test('deleting a repo deletes its plan branches', () => {
  const other = db.addRepo({ name: 'gone', path: '/tmp/plan-branches-gone', base_branch: 'main' });
  const owner = db.addTask({ repo_id: other.id, title: 'plan', prompt: 'p', status: 'proposed' });
  db.openPlanBranch({ plan_task: owner.id, repo_id: other.id, name: 'plan/2-y', base: 'main' }, [owner.id]);
  assert.equal(db.getTask(owner.id)?.target, 'plan/2-y');
  db.setRepoArchived(other.id, true);
  assert.ok(db.deleteRepo(other.id));
  assert.equal(db.planBranchNamed(other.id, 'plan/2-y'), undefined);
});
