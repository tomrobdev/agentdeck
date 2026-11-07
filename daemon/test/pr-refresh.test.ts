// The PR refresh's classify: where a PR goes in a refresh's findings, from what GitHub said and its check's verdict.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-pr-refresh-'));
const { classify } = await import('../src/application/landing/refresh.ts');

const clean = { mergeable: 'MERGEABLE', merge_state: 'CLEAN' };
const conflicting = { mergeable: 'CONFLICTING', merge_state: 'DIRTY' };
const unknown = { mergeable: 'UNKNOWN', merge_state: 'UNKNOWN' };

test('a merged or closed PR goes nowhere, whatever GitHub says about its mergeability', () => {
  for (const state of ['merged', 'closed'] as const)
    for (const pr of [clean, conflicting, unknown]) assert.equal(classify({ state, ...pr }, 'merge'), null, `${state} ${pr.mergeable}`);
});

test('an open PR that conflicts with the base is conflicting, whatever its verdict', () => {
  for (const verdict of ['merge', 'wait', 'never', null] as const)
    assert.equal(classify({ state: 'open', ...conflicting }, verdict), 'conflicting');
  assert.equal(classify({ state: 'open', mergeable: 'MERGEABLE', merge_state: 'DIRTY' }, null), 'conflicting');
});

test("an open PR whose mergeability GitHub hasn't worked out is unknown", () => {
  for (const verdict of ['merge', 'wait', null] as const) assert.equal(classify({ state: 'open', ...unknown }, verdict), 'unknown');
});

test('a clean open PR is mergeable only when its check says merge', () => {
  assert.equal(classify({ state: 'open', ...clean }, 'merge'), 'mergeable');
  assert.equal(classify({ state: 'open', ...clean }, 'wait'), null);
  assert.equal(classify({ state: 'open', ...clean }, 'never'), null);
  assert.equal(classify({ state: 'open', ...clean }, null), null);
});
