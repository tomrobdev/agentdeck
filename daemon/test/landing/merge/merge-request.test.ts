// Merge requests, the pure part: what each finding means to a request, and the view of one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  conflictsWithBase,
  mergeRequestCheck,
  mergeRequestPolls,
  mergeRequestView,
  mergesNow,
} from '#domain/landing/merge/merge-request.ts';
import { AUTO_MERGE_LABEL } from '#domain/landing/merge/auto-merge.ts';
import { type PrDetails, verdictView } from '#domain/landing/merge/merge.ts';
import { type PrFields, prFields, pullRequestOf } from '#domain/landing/pull-request/pr.ts';

const openPr = (o: Partial<PrFields> = {}) => pullRequestOf({ ...prFields(null), pr_url: 'https://x/pull/1', pr_state: 'open', ...o });

const ready: PrDetails = {
  state: 'open',
  draft: false,
  mergeable: 'MERGEABLE',
  merge_state: 'CLEAN',
  commits: 2,
  files: 2,
  additions: 30,
  deletions: 5,
  checks: { total: 2, failing: 0, pending: 0 },
  paths: ['src/a.ts', 'src/b.ts'],
  labels: [],
};

type Options = { pr_state?: 'open' | 'closed' | 'merged' | null; tests?: boolean | null; after?: boolean; auto_resolve?: boolean };
const raw = (pr: Partial<PrDetails> = {}, o: Options = {}) =>
  mergeRequestCheck({
    pr_state: o.pr_state === undefined ? 'open' : o.pr_state,
    pr: { ...ready, ...pr },
    tests_passed: o.tests === undefined ? true : o.tests,
    lands_after: o.after ? [{ on: 7, reason: 'its PR is open' }] : [],
    ...(o.auto_resolve === undefined ? {} : { auto_resolve: o.auto_resolve }),
  });
const check = (pr: Partial<PrDetails> = {}, o: Options = {}) => verdictView(raw(pr, o));

test('each reason says what it is about', () => {
  const kinds = (pr: Partial<PrDetails>, o: Options = {}) => raw(pr, o).reasons.map((r) => r.kind);
  assert.deepEqual(kinds({ checks: { total: 3, failing: 0, pending: 2 } }, { after: true }), ['lands_after', 'checks_pending']);
  assert.deepEqual(kinds({ mergeable: 'UNKNOWN' }), ['mergeability_unknown']);
  assert.deepEqual(kinds({ mergeable: 'CONFLICTING', merge_state: 'DIRTY' }), ['conflict']);
  assert.deepEqual(kinds({ checks: { total: 2, failing: 1, pending: 0 } }, { tests: false, pr_state: 'closed' }), [
    'not_open',
    'tests_failed',
    'checks_failing',
  ]);
});

test('with auto_resolve off a conflict needs a person and names the sync', () => {
  const off = check({ mergeable: 'CONFLICTING', merge_state: 'DIRTY' }, { auto_resolve: false });
  assert.equal(off.verdict, 'never');
  assert.match(off.reasons.join('\n'), /auto_resolve off.*sync/);
  assert.equal(off.conflict, true);
});

test('a clean PR merges, with or without a label, tests or checks', () => {
  assert.deepEqual(check(), { verdict: 'merge', reasons: [] });
  assert.equal(check({}, { tests: null }).verdict, 'merge');
  assert.equal(check({ checks: { total: 0, failing: 0, pending: 0 } }).verdict, 'merge');
});

test('pending checks, a conflict, lands after and unknown mergeability wait', () => {
  assert.deepEqual(check({ checks: { total: 3, failing: 0, pending: 2 } }), {
    verdict: 'wait',
    reasons: ['2 checks still running on GitHub'],
  });
  assert.deepEqual(check({ mergeable: 'CONFLICTING', merge_state: 'DIRTY' }).reasons, ['the branch has conflicts with the base branch']);
  assert.equal(check({ mergeable: 'CONFLICTING', merge_state: 'DIRTY' }).verdict, 'wait');
  assert.deepEqual(check({}, { after: true }), { verdict: 'wait', reasons: ['lands after #7: its PR is open'] });
  assert.deepEqual(check({ mergeable: 'UNKNOWN' }), {
    verdict: 'wait',
    reasons: ['GitHub is still working out whether it merges cleanly'],
  });
});

test('required checks running make GitHub say BLOCKED; the checks are the wait, not branch protection', () => {
  const r = check({ merge_state: 'BLOCKED', checks: { total: 2, failing: 0, pending: 1 } });
  assert.deepEqual(r, { verdict: 'wait', reasons: ['1 check still running on GitHub'] });
});

test('a failing check, failed tests, branch protection and a closed PR are never', () => {
  assert.deepEqual(check({ checks: { total: 2, failing: 1, pending: 0 } }), { verdict: 'never', reasons: ['1 check failing on GitHub'] });
  assert.deepEqual(check({}, { tests: false }), { verdict: 'never', reasons: ['tests failed on the last run'] });
  assert.equal(check({ merge_state: 'BLOCKED' }).verdict, 'never');
  assert.deepEqual(check({}, { pr_state: 'closed' }), { verdict: 'never', reasons: ['the PR is closed'] });
});

test('never wins over wait: only the reasons a person must act on are listed', () => {
  const r = check({ checks: { total: 3, failing: 1, pending: 1 } }, { after: true });
  assert.deepEqual(r, { verdict: 'never', reasons: ['1 check failing on GitHub'] });
});

test('a draft or a branch behind the base merges', () => {
  assert.equal(check({ draft: true, merge_state: 'DRAFT' }).verdict, 'merge');
  assert.equal(check({ merge_state: 'BEHIND' }).verdict, 'merge');
});

test("auto-merge's limits don't count: lines, skipped paths, no label", () => {
  const big = check({ additions: 5000, deletions: 100, paths: ['.github/workflows/ci.yml'], files: 1, labels: [] });
  assert.deepEqual(big, { verdict: 'merge', reasons: [] });
  assert.equal(check({ labels: [AUTO_MERGE_LABEL.name] }).verdict, 'merge');
});

test('a waiting request is read again soon only for running checks or mergeability GitHub has not worked out', () => {
  const pending = { ...ready, checks: { total: 2, failing: 0, pending: 1 } };
  assert.equal(mergeRequestPolls(raw(pending), pending), true);
  const unknown = { ...ready, mergeable: 'UNKNOWN' };
  assert.equal(mergeRequestPolls(raw(unknown), unknown), true);
  assert.equal(
    mergeRequestPolls(raw({}, { after: true }), ready),
    false,
    'a PR it lands after changes on a merge, which asks for a re-read',
  );
  assert.equal(mergeRequestPolls(raw(), ready), false);
});

test('mergeRequestView: none, waiting with its reasons, and merging', () => {
  assert.equal(mergeRequestView(null, false), null, 'no PR');
  assert.equal(mergeRequestView(openPr(), false), null);
  assert.equal(mergeRequestView(openPr(), true), null);

  const asked = { merge_requested_at: '2026-11-01 10:00:00', merge_request_method: 'rebase' as const };
  assert.deepEqual(mergeRequestView(openPr(asked), false), {
    state: 'waiting',
    method: 'rebase',
    reasons: [],
    since: '2026-11-01 10:00:00',
  });

  const waiting = openPr({ ...asked, merge_request_check: raw({ checks: { total: 3, failing: 0, pending: 2 } }) });
  assert.deepEqual(mergeRequestView(waiting, false), {
    state: 'waiting',
    method: 'rebase',
    reasons: ['2 checks still running on GitHub'],
    since: '2026-11-01 10:00:00',
  });
  assert.deepEqual(mergeRequestView(waiting, true), { state: 'merging', method: 'rebase', reasons: [], since: '2026-11-01 10:00:00' });
  assert.equal(mergeRequestView(openPr({ ...asked, merge_request_check: null }), false)!.reasons.length, 0);
  assert.equal(mergeRequestView(openPr({ ...asked, merge_request_method: null }), false)!.method, 'squash');
});

test('a check marks a conflict as data, and conflictsWithBase reads it from the stored checks of an open PR', () => {
  const dirty = { mergeable: 'CONFLICTING', merge_state: 'DIRTY' };
  assert.equal(check(dirty).conflict, true);
  assert.equal(check({ checks: { total: 3, failing: 0, pending: 2 } }).conflict, undefined, 'no conflict, no mark');
  assert.equal(check().conflict, undefined);

  const stored = raw(dirty);
  const requested = { merge_requested_at: '2026-11-01 10:00:00' };
  assert.equal(conflictsWithBase(null), false, 'no PR');
  assert.equal(conflictsWithBase(openPr()), false, 'no stored check');
  assert.equal(conflictsWithBase(openPr({ ...requested, merge_request_check: stored })), true);
  assert.equal(conflictsWithBase(openPr({ auto_merge_check: stored })), true, "auto-merge's check counts with no merge request");
  assert.equal(
    conflictsWithBase(openPr({ ...requested, merge_request_check: raw(), auto_merge_check: stored })),
    false,
    "the merge request's newer check wins",
  );
  assert.equal(
    conflictsWithBase(openPr({ ...requested, pr_state: 'merged', merge_request_check: stored })),
    false,
    'only an open PR conflicts',
  );
});

test("mergesNow: only failing checks or failed tests merge now, on the person's say-so; the rest goes through a request", () => {
  const now = (pr: Partial<PrDetails> = {}, o: { tests?: boolean | null; after?: boolean } = {}) =>
    mergesNow(raw(pr, o), { pr: { ...ready, ...pr }, tests_passed: o.tests === undefined ? true : o.tests });
  assert.equal(now({ checks: { total: 2, failing: 1, pending: 0 } }), true, 'a failing check');
  assert.equal(now({}, { tests: false }), true, 'failed tests');
  assert.equal(now(), false, 'a clean PR is a request that merges');
  assert.equal(now({ checks: { total: 2, failing: 0, pending: 1 } }), false, 'running checks are a request that waits');
  assert.equal(now({}, { after: true }), false, 'lands after is a request that waits');
  assert.equal(now({}, { tests: null }), false, 'tests not run');
  assert.equal(now({ merge_state: 'BLOCKED' }), false, 'branch protection alone: never, but nothing to wave through');
});
