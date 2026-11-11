// Pure tests of a task's history, the changes its non-status writes make, and the check of a proposal against the base.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asTaskId } from '#domain/shared/index.ts';
import {
  type ProposalCheck,
  autoMergeCheckChanges,
  autoMergeSettingChanges,
  emptyProposalCheck,
  isAutoMergeReason,
  latestRetryAt,
  latestReviewNote,
  mayOverlap,
  mergeReason,
  mergeRequestChanges,
  mergeRequestCheckChanges,
  mergedPrChanges,
  modelChanges,
  overlaps,
  parseBaseLog,
  prChanges,
  prChecksChanges,
  prChecksOpenedChanges,
  prEventReason,
  prEventsOf,
  prRetryFor,
  proposalCheckLine,
  questionChanges,
  staleness,
} from '#domain/work/index.ts';

const cleared = {
  auto_merge_check: null,
  auto_merge_checked_at: null,
  merge_requested_at: null,
  merge_request_method: null,
  merge_request_check: null,
};
const checks = { passed: 1, failed: 0, pending: 0, total: 1 } as never;

test('a PR that is still open was opened; one found merged or closed was opened and then seen so', () => {
  assert.deepEqual(prEventsOf({ url: 'u', state: 'open' } as never), [{ type: 'opened', url: 'u' }]);
  assert.deepEqual(prEventsOf({ url: 'u', state: 'merged' } as never), [
    { type: 'opened', url: 'u' },
    { type: 'seen', state: 'merged' },
  ]);
});

test('each PR event has its reason in the history', () => {
  assert.equal(prEventReason({ type: 'opened', url: 'u' }), 'opened u');
  assert.equal(prEventReason({ type: 'failed', error: 'no auth' }), 'could not open the PR: no auth');
  assert.equal(prEventReason({ type: 'closed' }), 'closed without merging');
  assert.equal(prEventReason({ type: 'seen', state: 'merged' }), 'PR is merged');
});

test('a done task whose PR failed to open is retried from its failed events, unless PRs are off or the PR did not fail', () => {
  const failed = {
    type: 'pr' as const,
    from_status: 'done' as const,
    to_status: 'done' as const,
    reason: 'could not open the PR: boom',
    at: '2026-01-01 00:00:00',
  };
  const now = Date.parse('2026-01-01T01:00:00Z');
  const task = { status: 'done' as const, pr: { state: 'failed' as const } };
  assert.equal(prRetryFor(task, { pr_mode: 'ready' }, [failed], now)?.state, 'due');
  assert.equal(prRetryFor(task, { pr_mode: 'ready' }, [failed], Date.parse('2026-01-01T00:01:00Z'))?.state, 'wait');
  assert.equal(prRetryFor(task, { pr_mode: 'off' }, [failed], now), null);
  assert.equal(prRetryFor(task, null, [failed], now), null);
  assert.equal(prRetryFor({ ...task, pr: { state: 'open' } }, { pr_mode: 'ready' }, [failed], now), null);
  assert.equal(prRetryFor({ ...task, status: 'blocked' }, { pr_mode: 'ready' }, [failed], now), null);
  assert.equal(prRetryFor(task, { pr_mode: 'ready' }, [], now), null);
});

test('a merge reason says who merged and how, and an auto-merge is told from the rest', () => {
  assert.equal(mergeReason('auto', 'squash'), 'auto-merged (squash)');
  assert.equal(mergeReason('request', 'merge'), 'requested (merge)');
  assert.equal(mergeReason('person', 'rebase'), 'rebase merge');
  assert.ok(isAutoMergeReason('auto-merged (squash)'));
  assert.ok(!isAutoMergeReason('requested (squash)') && !isAutoMergeReason(null));
});

test('the latest retry is the last retry, unblock retry or review retry event, with its time and its note', () => {
  const events = [
    { type: 'retry' as const, at: '1', reason: 'first' },
    { type: 'review_retry' as const, at: '2', reason: 'second' },
    { type: 'edit' as const, at: '3', reason: 'edited' },
  ];
  assert.equal(latestRetryAt(events), '2');
  assert.equal(latestReviewNote(events), 'second');
  assert.equal(latestRetryAt([{ type: 'unblock_retry', at: '9' }]), '9');
  assert.equal(latestRetryAt([]), null);
  assert.equal(latestReviewNote([{ type: 'edit', reason: 'x' }]), null);
});

test('the writes of a model, a question and the merge settings change only their own fields, and clear what they make stale', () => {
  assert.deepEqual(modelChanges('opus'), { model: 'opus' });
  assert.deepEqual(questionChanges({ question: 'q', options: ['a'] }), { question: { question: 'q', options: ['a'] } });
  assert.deepEqual(autoMergeSettingChanges(true), { auto_merge: true, auto_merge_check: null, auto_merge_checked_at: null });
  assert.deepEqual(autoMergeCheckChanges(null), { auto_merge_check: null, auto_merge_checked_at: null });
  assert.equal(autoMergeCheckChanges({ ok: true } as never).auto_merge_checked_at, 'now');
  assert.deepEqual(mergeRequestChanges('squash'), { merge_requested_at: 'now', merge_request_method: 'squash', merge_request_check: null });
  assert.deepEqual(mergeRequestCheckChanges({ ok: false } as never), { merge_request_check: { ok: false } });
  assert.deepEqual(prChecksOpenedChanges(checks), { pr_checks_opened: checks });
  assert.deepEqual(prChecksChanges({ runs: [] } as never), { pr_checks: { runs: [] } });
});

test('a PR event sets the PR state and clears the auto-merge check and merge request; an opened one also clears its checks', () => {
  assert.deepEqual(prChanges({ type: 'opened', url: 'u' }), {
    pr_url: 'u',
    pr_state: 'open',
    pr_checks_opened: null,
    pr_checks_merged: null,
    pr_checks: null,
    ...cleared,
  });
  assert.deepEqual(prChanges({ type: 'failed', error: 'e' }), { pr_state: 'failed', ...cleared });
  assert.deepEqual(prChanges({ type: 'closed' }), { pr_state: 'closed', ...cleared });
  assert.deepEqual(prChanges({ type: 'seen', state: 'merged' }), { pr_state: 'merged', ...cleared });
  assert.deepEqual(mergedPrChanges('squash'), { pr_state: 'merged', merge_method: 'squash', ...cleared });
  assert.equal(mergedPrChanges('merge', checks).pr_checks_merged, checks);
});

const commit = (sha: string, paths: string[]) => ({ sha, subject: `s ${sha}`, at: '2026-01-01 00:00:00', paths });

test('staleness lists each named path (or folder) the base changed since the task was added, with the commits that changed it', () => {
  const result = staleness(
    ['src/a.ts', 'docs/', 'untouched.ts'],
    [commit('1', ['src/a.ts']), commit('2', ['docs/x.md', 'other']), commit('3', ['elsewhere'])],
  );
  assert.equal(result.commits, 3);
  assert.deepEqual(
    result.changed.map((c) => [c.path, c.commits.map((x) => x.sha)]),
    [
      ['src/a.ts', ['1']],
      ['docs/', ['2']],
    ],
  );
  assert.deepEqual(staleness([], []), { commits: 0, changed: [] });
});

test('only open work can overlap: proposed, queued, running, or done with an open PR', () => {
  assert.ok(
    mayOverlap({ status: 'proposed', pr: null }) &&
      mayOverlap({ status: 'queued', pr: null }) &&
      mayOverlap({ status: 'running', pr: null }),
  );
  assert.ok(mayOverlap({ status: 'done', pr: { state: 'open' } }));
  assert.ok(!mayOverlap({ status: 'done', pr: { state: 'merged' } }) && !mayOverlap({ status: 'done', pr: null }));
  assert.ok(!mayOverlap({ status: 'blocked', pr: null }));
});

test('overlaps lists the tasks that share a path or a folder with the task, by id, with the shared paths', () => {
  const candidate = (id: number, paths: string[], linked = false) => ({
    id: asTaskId(id),
    title: `t${id}`,
    status: 'queued' as const,
    paths,
    linked,
  });
  const found = overlaps(
    ['src/a.ts', 'docs/'],
    [candidate(9, ['docs/x.md']), candidate(3, ['src/a.ts', 'src/b.ts'], true), candidate(5, ['nope'])],
  );
  assert.deepEqual(
    found.map((o) => [o.id, o.paths, o.linked]),
    [
      [3, ['src/a.ts'], true],
      [9, ['docs/x.md'], false],
    ],
  );
  assert.deepEqual(overlaps([], [candidate(1, ['a'])]), []);
});

test('the check line says how far behind the prompt is, how many named files changed and who it shares files with, and is null when nothing is', () => {
  assert.equal(proposalCheckLine(emptyProposalCheck()), null);
  const check: ProposalCheck = {
    staleness: {
      ref: 'main',
      base: 'abc',
      commits: 1,
      changed: [
        { path: 'a', commits: [] },
        { path: 'b', commits: [] },
      ],
    },
    notes: [],
    overlaps: [
      { id: asTaskId(4), title: 't', status: 'queued', paths: ['a'], linked: false },
      { id: asTaskId(5), title: 't', status: 'queued', paths: ['a'], linked: true },
    ],
  };
  assert.equal(proposalCheckLine(check), 'written 1 commit ago · 2 named files changed · touches the same files as #4');
});

test('parseBaseLog reads the base log into commits with their subject, UTC time and changed paths', () => {
  const out = '\x1eaaa\x1ffirst\x1f2026-01-02T03:04:05+00:00\0\nsrc/a.ts\0src/b.ts\x1ebbb\x1fsecond\x1f2026-01-02T05:00:00+02:00\0';
  const log = parseBaseLog(out);
  assert.equal(log.length, 2);
  assert.deepEqual(
    [log[0].sha, log[0].subject, log[0].at, log[0].paths],
    ['aaa', 'first', '2026-01-02 03:04:05', ['src/a.ts', 'src/b.ts']],
  );
  assert.deepEqual(log[1].paths, []);
  assert.deepEqual(parseBaseLog(''), []);
});
