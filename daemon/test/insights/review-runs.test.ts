import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ScorecardReviewRun,
  type ScorecardRunReview,
  measureReviewRuns,
  mergedUnchanged,
  reviewRunsText,
} from '../../src/domain/insights/review-runs.ts';
import { type ScorecardEvent, buildScorecard, scorecardText } from '../../src/domain/insights/scorecard.ts';
import { asRepoId, asTaskId } from '../fixtures/fixtures.ts';

const ev = (o: Partial<ScorecardEvent> & { type: string; at: string }): ScorecardEvent => ({
  task_id: asTaskId(1),
  repo_id: asRepoId(1),
  from_status: null,
  to_status: null,
  reason: null,
  ...o,
});
const run = (o: Partial<ScorecardReviewRun> = {}): ScorecardReviewRun => ({
  task_id: asTaskId(1),
  repo_id: asRepoId(1),
  diff_hash: 'h1',
  outcome: 'done',
  started_at: '2026-10-05 10:00:00',
  ...o,
});
const review = (o: Partial<ScorecardRunReview> = {}): ScorecardRunReview => ({
  task_id: asTaskId(1),
  diff_hash: 'h1',
  kind: 'comment',
  ...o,
});

test('a blocking review run counts as merged unchanged when the PR merged with no work run or retry after it', () => {
  const started = { started_at: '2026-10-05 10:00:00' };
  assert.equal(mergedUnchanged(started, [ev({ type: 'merge', at: '2026-10-05 11:00:00' })]), true);
  assert.equal(mergedUnchanged(started, [ev({ type: 'pr', reason: 'PR is merged', at: '2026-10-05 11:00:00' })]), true);
  assert.equal(mergedUnchanged(started, [ev({ type: 'pr_merged', at: '2026-10-05 11:00:00' })]), true);
  // A merge before the review run does not count, and neither does no merge at all.
  assert.equal(mergedUnchanged(started, [ev({ type: 'merge', at: '2026-10-05 09:00:00' })]), false);
  assert.equal(mergedUnchanged(started, [ev({ type: 'pr', reason: 'checks passed', at: '2026-10-05 11:00:00' })]), false);
  for (const type of ['claim', 'review_retry', 'retry'])
    assert.equal(
      mergedUnchanged(started, [ev({ type: 'merge', at: '2026-10-05 12:00:00' }), ev({ type, at: '2026-10-05 11:00:00' })]),
      false,
      type,
    );
});

test('review run measures: clean, asked for changes, merged unchanged and no review; runs given back are not counted', () => {
  const runs = [
    run({ task_id: asTaskId(1), diff_hash: 'a' }),
    run({ task_id: asTaskId(2), diff_hash: 'b' }),
    run({ task_id: asTaskId(3), diff_hash: 'c' }),
    run({ task_id: asTaskId(4), diff_hash: 'd', outcome: 'failed' }),
    run({ task_id: asTaskId(5), diff_hash: null }),
    run({ task_id: asTaskId(6), outcome: 'rate_limited' }),
    run({ task_id: asTaskId(7), outcome: 'interrupted' }),
    run({ task_id: asTaskId(8), outcome: null }),
  ];
  const reviews = [
    review({ task_id: asTaskId(1), diff_hash: 'a', kind: 'approve' }),
    review({ task_id: asTaskId(2), diff_hash: 'b', kind: 'request_changes' }),
    review({ task_id: asTaskId(3), diff_hash: 'c', kind: 'request_changes' }),
    // A review of other changes is not this run's.
    review({ task_id: asTaskId(4), diff_hash: 'old', kind: 'approve' }),
    review({ task_id: asTaskId(5), diff_hash: null, kind: 'approve' }),
  ];
  const history: Record<number, ScorecardEvent[]> = {
    2: [ev({ task_id: asTaskId(2), type: 'merge', at: '2026-10-05 11:00:00' })],
    3: [
      ev({ task_id: asTaskId(3), type: 'claim', at: '2026-10-05 10:30:00' }),
      ev({ task_id: asTaskId(3), type: 'merge', at: '2026-10-05 11:00:00' }),
    ],
  };
  const m = measureReviewRuns(runs, reviews, (id) => history[id] ?? []);
  assert.deepEqual(m, { runs: 5, clean: 1, asked_changes: 2, merged_unchanged: 1, no_review: 2 });
  assert.equal(
    reviewRunsText(m),
    'review runs: 5 (1 clean, 2 asked for changes, 1 of them merged unchanged by a person; 2 left no review)',
  );
  assert.equal(
    reviewRunsText({ ...m, no_review: 0 }),
    'review runs: 5 (1 clean, 2 asked for changes, 1 of them merged unchanged by a person)',
  );
  assert.equal(reviewRunsText(measureReviewRuns([], [], () => [])), 'review runs: none');
});

test('the scorecard counts review runs per repo, per week and in total, by when they started', () => {
  const card = buildScorecard({
    tasks: [],
    events: [ev({ task_id: asTaskId(2), repo_id: asRepoId(2), type: 'merge', at: '2026-10-14 11:00:00' })],
    samples: [],
    review_runs: [
      run({ task_id: asTaskId(1), repo_id: asRepoId(1), diff_hash: 'a', started_at: '2026-09-01 10:00:00' }),
      run({ task_id: asTaskId(1), repo_id: asRepoId(1), diff_hash: 'b', started_at: '2026-10-06 10:00:00' }),
      run({ task_id: asTaskId(2), repo_id: asRepoId(2), diff_hash: 'c', started_at: '2026-10-14 10:00:00' }),
    ],
    run_reviews: [
      review({ task_id: asTaskId(1), diff_hash: 'b', kind: 'approve' }),
      review({ task_id: asTaskId(2), diff_hash: 'c', kind: 'request_changes' }),
    ],
    repoName: (id) => `repo${id}`,
    since: '2026-10-01 00:00:00',
    by: 'week',
  });
  assert.deepEqual(
    card.repos.map((r) => [r.repo, r.measures.review_runs.runs]),
    [
      ['repo1', 1],
      ['repo2', 1],
    ],
  );
  assert.deepEqual(card.total.review_runs, { runs: 2, clean: 1, asked_changes: 1, merged_unchanged: 1, no_review: 0 });
  assert.deepEqual(
    card.weeks.map((w) => [w.week, w.measures.review_runs.runs]),
    [
      ['2026-10-05', 1],
      ['2026-10-12', 1],
    ],
  );
  assert.match(scorecardText(card), /review runs: 2 \(1 clean, 1 asked for changes, 1 of them merged unchanged by a person\)/);

  const none = buildScorecard({ tasks: [], events: [], samples: [], repoName: String });
  assert.deepEqual(none.total.review_runs, { runs: 0, clean: 0, asked_changes: 0, merged_unchanged: 0, no_review: 0 });
});
