import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_MERGE_LABEL } from '../../../src/domain/landing/merge/auto-merge.ts';
import type { AutoMergeFacts, MergeInput, PrDetails } from '../../../src/domain/landing/index.ts';
import { refreshVerdict } from '../../../src/domain/landing/index.ts';

const ready: PrDetails = {
  state: 'open',
  draft: false,
  mergeable: 'MERGEABLE',
  merge_state: 'CLEAN',
  commits: 1,
  files: 1,
  additions: 10,
  deletions: 2,
  checks: { total: 1, failing: 0, pending: 0 },
  head: 'head-1',
  paths: ['src/a.ts'],
  labels: [AUTO_MERGE_LABEL.name],
};

const clean = { mergeable: 'MERGEABLE', merge_state: 'CLEAN' };
const conflicting = { mergeable: 'CONFLICTING', merge_state: 'DIRTY' };
const unknown = { mergeable: 'UNKNOWN', merge_state: 'UNKNOWN' };
const pending = { checks: { total: 2, failing: 0, pending: 1 } };
const failing = { checks: { total: 2, failing: 1, pending: 0 } };

const input = (pr: Partial<PrDetails> = {}, o: Partial<MergeInput> = {}): MergeInput => ({
  pr_state: 'open',
  pr: { ...ready, ...pr },
  tests_passed: true,
  ...o,
});
const facts: AutoMergeFacts = {
  repo: { test_cmd: 'pnpm test', auto_merge_max_lines: 400, auto_merge_skip: [] },
  paused: null,
};

const brief = (v: ReturnType<typeof refreshVerdict>) => ({
  auto: v.auto_merge_check?.verdict ?? null,
  request: v.request_check?.verdict ?? null,
  drop: v.drop,
  place: v.place,
  polling: v.polling,
});

test('refreshVerdict: without a merge request, auto-merge decides, its check is kept and nothing is dropped', () => {
  const rows: [string, Partial<PrDetails>, AutoMergeFacts | null, ReturnType<typeof brief>][] = [
    ['clean, auto-merge on', clean, facts, { auto: 'merge', request: null, drop: null, place: 'mergeable', polling: false }],
    ['clean, auto-merge off', clean, null, { auto: null, request: null, drop: null, place: null, polling: false }],
    ['conflicting, on', conflicting, facts, { auto: 'wait', request: null, drop: null, place: 'conflicting', polling: false }],
    ['conflicting, off', conflicting, null, { auto: null, request: null, drop: null, place: 'conflicting', polling: false }],
    ['unknown mergeability, on', unknown, facts, { auto: 'wait', request: null, drop: null, place: 'unknown', polling: false }],
    ['unknown mergeability, off', unknown, null, { auto: null, request: null, drop: null, place: 'unknown', polling: false }],
    ['checks running, on', pending, facts, { auto: 'wait', request: null, drop: null, place: null, polling: false }],
    ['a check failing, on', failing, facts, { auto: 'never', request: null, drop: null, place: null, polling: false }],
    ['no label, on', { labels: [] }, facts, { auto: 'never', request: null, drop: null, place: null, polling: false }],
  ];
  for (const [name, pr, auto, want] of rows)
    assert.deepEqual(brief(refreshVerdict({ input: input(pr), requested: false, auto })), want, name);
});

test('refreshVerdict: with a merge request, its check stands in for auto-merge, and one that needs a person is dropped', () => {
  const rows: [string, Partial<PrDetails>, Partial<MergeInput>, ReturnType<typeof brief>][] = [
    ['clean', clean, {}, { auto: null, request: 'merge', drop: null, place: 'mergeable', polling: false }],
    ['no label: a person asked', { labels: [] }, {}, { auto: null, request: 'merge', drop: null, place: 'mergeable', polling: false }],
    ['checks running', pending, {}, { auto: null, request: 'wait', drop: null, place: null, polling: true }],
    ['unknown mergeability', unknown, {}, { auto: null, request: 'wait', drop: null, place: 'unknown', polling: true }],
    ['conflicting', conflicting, {}, { auto: null, request: 'wait', drop: null, place: 'conflicting', polling: false }],
    [
      'lands after',
      clean,
      { lands_after: [{ on: 7, reason: 'its PR is open' }] },
      { auto: null, request: 'wait', drop: null, place: null, polling: false },
    ],
    ['a check failing', failing, {}, { auto: null, request: null, drop: '1 check failing on GitHub', place: null, polling: false }],
    [
      'tests failed',
      clean,
      { tests_passed: false },
      { auto: null, request: null, drop: 'tests failed on the last run', place: null, polling: false },
    ],
    [
      'conflicting with auto_resolve off: dropped, and goes nowhere',
      conflicting,
      { auto_resolve: false },
      {
        auto: null,
        request: null,
        drop: 'the branch has conflicts with the base branch, and the repo has auto_resolve off: sync the task (agentdeck sync, or Sync in the dashboard)',
        place: null,
        polling: false,
      },
    ],
  ];
  for (const [name, pr, o, want] of rows)
    assert.deepEqual(brief(refreshVerdict({ input: input(pr, o), requested: true, auto: facts })), want, name);
});

test('refreshVerdict: a dropped request is told every reason it needs a person, in order', () => {
  const v = refreshVerdict({ input: input({ ...failing, merge_state: 'BLOCKED' }, { tests_passed: false }), requested: true, auto: null });
  assert.equal(
    v.drop,
    'GitHub says branch protection may block this merge (required reviews or checks); tests failed on the last run; 1 check failing on GitHub',
  );
});

test('refreshVerdict: a PR GitHub no longer has open goes nowhere, whatever its mergeability', () => {
  for (const state of ['merged', 'closed'] as const)
    for (const pr of [clean, conflicting, unknown])
      for (const requested of [false, true])
        assert.equal(refreshVerdict({ input: input({ state, ...pr }), requested, auto: facts }).place, null, `${state} ${pr.mergeable}`);
});
