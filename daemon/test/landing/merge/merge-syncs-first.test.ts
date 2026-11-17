// A person's merge of a PR that conflicts with the base (the pure part): it syncs first only when the conflict is the one problem and the repo resolves its own conflicts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type MergeInput, type PrDetails, mergeSyncsFirst, syncingFirstLine } from '#domain/landing/merge/merge.ts';

const clean: PrDetails = {
  state: 'open',
  draft: false,
  mergeable: 'MERGEABLE',
  merge_state: 'CLEAN',
  commits: 1,
  files: 1,
  additions: 3,
  deletions: 1,
  checks: { total: 1, failing: 0, pending: 0 },
  paths: [],
  labels: [],
};
const conflicting: PrDetails = { ...clean, mergeable: 'CONFLICTING', merge_state: 'DIRTY' };
const input = (pr: PrDetails, o: Partial<MergeInput> = {}): MergeInput => ({ pr_state: 'open', pr, tests_passed: true, ...o });

test('a conflict alone syncs first, and with auto_resolve off it is refused as before', () => {
  assert.equal(mergeSyncsFirst(input(conflicting)), true);
  assert.equal(mergeSyncsFirst(input(conflicting, { auto_resolve: true })), true);
  assert.equal(mergeSyncsFirst(input(conflicting, { auto_resolve: false })), false);
});

test('a PR without a conflict, or with another problem beside it, does not sync first', () => {
  assert.equal(mergeSyncsFirst(input(clean)), false);
  assert.equal(mergeSyncsFirst(input(conflicting, { pr_state: 'closed' })), false);
  assert.equal(mergeSyncsFirst(input(conflicting, { lands_after: [{ on: 7, reason: 'its PR is open' }] })), false);
});

test('the line says the base, the sync and the merge that follows', () => {
  assert.equal(syncingFirstLine('main'), 'conflicts with main: syncing, it merges once the sync is clean and the tests pass');
});
