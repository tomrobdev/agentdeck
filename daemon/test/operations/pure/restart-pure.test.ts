// Pure tests of when the daemon may restart and when a repo is due for an area review.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  offMain,
  reloadDecision,
  reloadState,
  remindReviewDue,
  restartWait,
  reviewDue,
  reviewDueDaysError,
  reviewDueLinesError,
  reviewDueNotification,
} from '#domain/operations/index.ts';
import { asRepoId } from '#domain/shared/index.ts';

const idle = { tasks: 0, planner: 0, resolves: 0 };
const input = { enabled: true, changed: ['a.ts'], lastChangeAt: 0, now: 10_000, activity: idle };

test('restartWait names what is still running, and is null when nothing is', () => {
  assert.equal(restartWait(idle), null);
  assert.equal(
    restartWait({ tasks: 1, planner: 2, resolves: 1, unblocks: 1, reviews: 2, verifies: 1 }),
    '1 running task and 1 resolve run and 1 unblock run and 2 review runs and 1 verify run and 2 planner runs',
  );
});

test('restartWait names API requests still being carried out', () => {
  assert.equal(restartWait({ ...idle, requests: 1 }), '1 API request');
  assert.equal(restartWait({ ...idle, tasks: 1, requests: 2 }), '1 running task and 2 API requests');
});

test('a requested restart waits for running work, else exits at once, whatever the setting says', () => {
  const busy = reloadDecision({ ...input, enabled: false, changed: [], requested: true, activity: { ...idle, tasks: 2 } });
  assert.deepEqual([busy.pending, busy.exit], [true, false]);
  assert.match(busy.reason, /restart requested; restarting once 2 running tasks finish/);
  assert.deepEqual(reloadDecision({ ...input, requested: true }).exit, true);
});

test('a source change reloads only when enabled, not blocked, nothing runs and the edits have settled', () => {
  assert.deepEqual(reloadDecision({ ...input, enabled: false }), { pending: false, exit: false, reason: '' });
  assert.deepEqual(reloadDecision({ ...input, changed: [] }), { pending: false, exit: false, reason: '' });
  assert.equal(reloadDecision({ ...input, blocked: offMain('feature') }).reason, 'not reloading: the checkout is on feature, not main');
  assert.match(reloadDecision({ ...input, activity: { ...idle, tasks: 1 } }).reason, /reloading once 1 running task finish/);
  assert.match(reloadDecision({ ...input, lastChangeAt: 9_500 }).reason, /waiting for edits to settle/);
  const go = reloadDecision({ ...input, changed: ['a.ts', 'b.ts', 'c.ts'] });
  assert.equal(go.exit, true);
  assert.match(go.reason, /source changed \(c\.ts and 2 more\) and nothing is running/);
  assert.equal(reloadDecision({ ...input, lastChangeAt: null }).exit, true);
});

test('the reload state tells what it waits for and what blocks it, only while there are changes', () => {
  const waiting = reloadState({ ...input, activity: { ...idle, tasks: 1 } });
  assert.deepEqual([waiting.pending, waiting.waiting, waiting.blocked, waiting.changed], [true, '1 running task', null, 1]);
  assert.equal(reloadState({ ...input, blocked: 'why' }).blocked, 'why');
  assert.equal(reloadState({ ...input, changed: [], blocked: 'why' }).blocked, null);
  assert.equal(reloadState({ ...input, enabled: false }).reason, null);
});

const DAY = 24 * 60 * 60 * 1000;
const repo = { id: asRepoId(1), name: 'r' };

test('a repo is due for an area review when its oldest mark is over the days or the lines merged are over the limit', () => {
  const settings = { days: 7, lines: 1000 };
  const now = 100 * DAY;
  assert.equal(reviewDue(repo, { marks: [{ area: 'plan', at: now - DAY }], commits: 3, lines: 10 }, settings, now), null);
  const old = reviewDue(
    repo,
    {
      marks: [
        { area: 'a', at: now - 9 * DAY },
        { area: 'b', at: now - 2 * DAY },
      ],
      commits: 4,
      lines: 10,
    },
    settings,
    now,
  );
  assert.deepEqual([old?.area, old?.days, old?.line], ['a', 9, 'area review due: 9 days, 4 commits since the last']);
  const big = reviewDue(repo, { marks: [{ area: 'a', at: now }], commits: 1, lines: 2000 }, settings, now);
  assert.equal(big?.days, 0);
  const none = reviewDue(repo, { marks: [], commits: 1, lines: 5000 }, settings, now);
  assert.equal(none?.line, 'area review due: none yet, 1 commit (5,000 lines) merged since the repo was added');
  assert.equal(reviewDue(repo, { marks: [], commits: 1, lines: 5 }, settings, now), null);
});

test('a due review is reminded about once a day, and its notification names the repo and the oldest mark', () => {
  assert.ok(remindReviewDue(null, 5));
  assert.ok(!remindReviewDue(1000, 1000 + DAY - 1));
  assert.ok(remindReviewDue(1000, 1000 + DAY));
  const n = reviewDueNotification({
    repo_id: asRepoId(1),
    repo: 'r',
    area: 'plan',
    days: 9,
    commits: 4,
    lines: 10,
    line: 'area review due: 9 days, 4 commits since the last',
  });
  assert.deepEqual([n.kind, n.title], ['review_due', 'r: area review due']);
  assert.match(n.body, /^9 days, 4 commits since the last\. The oldest mark is refs\/reviewed\/plan\. Run the review-area skill/);
  assert.doesNotMatch(
    reviewDueNotification({ repo_id: asRepoId(1), repo: 'r', area: null, days: null, commits: 1, lines: 1, line: 'x' }).body,
    /oldest mark/,
  );
});

test('the review limits are whole numbers in range', () => {
  assert.equal(reviewDueDaysError(7), null);
  assert.match(reviewDueDaysError(0) ?? '', /review_due_days must be a whole number from 1 to 365/);
  assert.equal(reviewDueLinesError(3000), null);
  assert.match(reviewDueLinesError(2_000_000) ?? '', /review_due_lines/);
});
