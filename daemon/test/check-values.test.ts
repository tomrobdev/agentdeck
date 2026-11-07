// The stored PR check columns are parsed once, in the mapper: a malformed or half-written document reads as no value.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCheck, readCounts, stored, toTask } from '../src/db/mappers.ts';
import { openDb } from '../src/db/index.ts';

test('readCheck: a stored check is a verdict with its reasons, and anything else is none', () => {
  assert.deepEqual(readCheck('{"verdict":"wait","reasons":["x",3]}'), { verdict: 'wait', reasons: ['x'] });
  assert.deepEqual(readCheck('{"verdict":"never","reasons":[],"conflict":true}'), { verdict: 'never', reasons: [], conflict: true });
  assert.equal(readCheck('{"verdict":"maybe","reasons":[]}'), null);
  assert.equal(readCheck('not json'), null);
  assert.equal(readCheck(null), null);
});

test('readCounts: stored check counts need all three numbers', () => {
  assert.deepEqual(readCounts('{"total":3,"failing":1,"pending":0}'), { total: 3, failing: 1, pending: 0 });
  assert.equal(readCounts('{"total":3}'), null);
  assert.equal(readCounts('nonsense'), null);
  assert.equal(readCounts(null), null);
});

test('stored checks read as values, and stored() turns them back for the API', () => {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'demo', path: '/tmp/demo', base_branch: 'main' });
  const t = db.addTask({ repo_id: repo.id, title: 't', prompt: 'p' });
  const row = { ...db.getTask(t.id)!, pr_checks: '{"read_at":"x","checks":[]}', pr_checks_opened: 'bad' };
  const task = toTask(row as never);
  assert.deepEqual(task.pr?.checks.latest, { read_at: 'x', head: null, checks: [], notified: false });
  assert.equal(task.pr?.checks.opened, null);
  assert.equal(stored({ pr_checks_merged: { total: 1, failing: 0, pending: 0 } }).pr_checks_merged, '{"total":1,"failing":0,"pending":0}');
});
