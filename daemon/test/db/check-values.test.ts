// The stored PR check columns are parsed once, in the mapper: a malformed or half-written document reads as no value.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCheck, readCounts, toTask } from '../../src/db/mappers.ts';
import { stored } from '../../src/domain/shared/index.ts';
import { openDb } from '../../src/db/index.ts';

test('readCheck: a stored check is a verdict with its reasons, and anything else is none', () => {
  const pending = { kind: 'checks_pending', text: '1 check still running on GitHub' };
  assert.deepEqual(readCheck(JSON.stringify({ verdict: 'wait', reasons: [pending, { kind: 'x' }, 3] })), {
    verdict: 'wait',
    reasons: [pending],
  });
  assert.deepEqual(readCheck('{"verdict":"never","reasons":[],"conflict":true}'), { verdict: 'never', reasons: [], conflict: true });
  assert.equal(readCheck('{"verdict":"maybe","reasons":[]}'), null);
  assert.equal(readCheck('not json'), null);
  assert.equal(readCheck(null), null);
});

test('readCheck: a check stored before reasons had kinds reads its plain-string reasons as kind other', () => {
  assert.deepEqual(readCheck('{"verdict":"wait","reasons":["x",3]}'), { verdict: 'wait', reasons: [{ kind: 'other', text: 'x' }] });
  assert.deepEqual(readCheck('{"verdict":"never","reasons":["the branch has conflicts with the base branch"],"conflict":true}'), {
    verdict: 'never',
    reasons: [{ kind: 'other', text: 'the branch has conflicts with the base branch' }],
    conflict: true,
  });
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
