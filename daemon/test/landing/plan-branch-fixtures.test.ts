import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parsePrDetails } from '#domain/landing/index.ts';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, '../fixtures/gh', `${name}.json`), 'utf8');

test('a task PR into a plan branch parses as open and clean, with no checks', () => {
  const json = fixture('pr-view-plan-branch-task');
  assert.equal(JSON.parse(json).baseRefName, 'plan/4-e2e-plan-branch');
  const pr = parsePrDetails(json);
  assert.equal(pr.state, 'open');
  assert.equal(pr.draft, false);
  assert.equal(pr.mergeable, 'MERGEABLE');
  assert.equal(pr.merge_state, 'CLEAN');
  assert.deepEqual(pr.checks, { total: 0, failing: 0, pending: 0 });
  assert.deepEqual(pr.check_list, []);
  assert.deepEqual(pr.paths, ['fake-output.txt']);
  assert.deepEqual(pr.labels, ['agentdeck:auto-merge']);
});

test('the plan PR into main parses with its four commits and no checks', () => {
  const json = fixture('pr-view-plan-branch');
  assert.equal(JSON.parse(json).baseRefName, 'main');
  const pr = parsePrDetails(json);
  assert.equal(pr.state, 'open');
  assert.equal(pr.commits, 4);
  assert.equal(pr.head, '2738386da1693c275eaac1f44aeff4ce67d5c823');
  assert.equal(pr.mergeable, 'MERGEABLE');
  assert.deepEqual(pr.checks, { total: 0, failing: 0, pending: 0 });
  assert.deepEqual(pr.labels, []);
});
