// How the dashboard words a pull request's path to merging.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoMergeLine, describeMergeRequest, describePrRetry, syncLine } from '#app/lib/landing/landing-wording.ts';

test('auto-merge says it merges on the next refresh, waits with its reasons, or needs a person', () => {
  assert.equal(autoMergeLine({ verdict: 'merge', reasons: [] } as never), 'on; merges on the next PR refresh');
  assert.equal(autoMergeLine({ verdict: 'wait', reasons: ['checks running', 'review'] } as never), 'on; waiting: checks running; review');
  assert.equal(autoMergeLine({ verdict: 'person', reasons: ['too big'] } as never), 'needs you: too big');
});

test('a merge request is merging, or merging when ready with what it waits for', () => {
  assert.equal(describeMergeRequest({ state: 'merging', reasons: [] } as never), 'Merging…');
  assert.equal(describeMergeRequest({ state: 'waiting', reasons: ['checks', 'sync'] } as never), 'Merging when ready · checks · sync');
});

test('a sync is worded by its outcome, with the file count or the reason', () => {
  assert.equal(syncLine({ outcome: 'resolved', files: ['a', 'b'] }), 'Resolved conflicts in 2 files.');
  assert.equal(syncLine({ outcome: 'resolved', files: ['a'] }), 'Resolved conflicts in 1 file.');
  assert.equal(syncLine({ outcome: 'clean', files: [] }), 'Synced with the base branch.');
  assert.equal(syncLine({ outcome: 'up_to_date', files: [] }), 'The branch is already synced with the base branch.');
  assert.equal(syncLine({ outcome: 'blocked', files: [], reason: 'conflicts' }), 'Blocked: conflicts');
  assert.equal(syncLine({ outcome: 'blocked', files: [] }), 'Blocked: the conflicts could not be settled');
  assert.equal(syncLine({ outcome: 'error', files: [], reason: 'git broke' }), 'git broke');
  assert.equal(syncLine({ outcome: 'deferred', files: [] }), 'deferred');
});

test('a failed PR open says how many tries failed, and when it tries again or that a person must open it', () => {
  const base = { failures: 1, error: 'no auth', state: 'wait', next_at: null } as never;
  assert.equal(describePrRetry(base), '1 try to open the PR failed: no auth. The PR refresh tries again.');
  assert.match(
    describePrRetry({ ...(base as object), failures: 2, next_at: '2026-01-01 10:00:00' } as never),
    /^2 tries .*tries again at /,
  );
  assert.equal(
    describePrRetry({ failures: 6, error: 'x', state: 'person', next_at: null } as never),
    '6 tries to open the PR failed: x. The PR refresh stopped trying; open it by hand.',
  );
});
