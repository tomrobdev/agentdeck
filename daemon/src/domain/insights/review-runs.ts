// What the scorecard counts of review runs: how many ran, how many asked for changes, and how many of those a person then merged unchanged, so their judgement can be weighed against a person's.
import { reviewRunCounts } from '../landing/index.ts';
import type { RepoId, TaskId } from '../shared/index.ts';
import type { ScorecardEvent } from './scorecard.ts';

/** A review run, with its task's repo, as the scorecard reads it. */
export interface ScorecardReviewRun {
  task_id: TaskId;
  repo_id: RepoId;
  /** The patch-id of the changes it was started to read. */
  diff_hash: string | null;
  /** How it ended; null while it runs. */
  outcome: string | null;
  started_at: string;
}

/** A submitted review a review run left: the changes it read and what it said. */
export interface ScorecardRunReview {
  task_id: TaskId;
  diff_hash: string | null;
  kind: string | null;
}

export interface ReviewRunMeasures {
  /** Review runs that ended, other than those a rate limit or a restart stopped (another starts in their place). */
  runs: number;
  /** Of those, the ones whose review found nothing blocking. */
  clean: number;
  /** Of those, the ones whose review asked for changes. */
  asked_changes: number;
  /** Of those that asked for changes, the ones a person then merged unchanged: no work run and no retry after it. */
  merged_unchanged: number;
  /** Of those, the ones that left no review: they failed, answered garbage or were stopped. */
  no_review: number;
}

const isMerged = (e: Pick<ScorecardEvent, 'type' | 'reason'>): boolean =>
  e.type === 'merge' || e.type === 'pr_merged' || (e.type === 'pr' && e.reason === 'PR is merged');

export function mergedUnchanged(
  run: Pick<ScorecardReviewRun, 'started_at'>,
  events: Pick<ScorecardEvent, 'type' | 'reason' | 'at'>[],
): boolean {
  const after = [...events].filter((e) => e.at >= run.started_at).sort((a, b) => a.at.localeCompare(b.at));
  const merged = after.findIndex(isMerged);
  if (merged === -1) return false;
  return !after.slice(0, merged).some((e) => e.type === 'claim' || e.type === 'review_retry' || e.type === 'retry');
}

export function measureReviewRuns(
  runs: ScorecardReviewRun[],
  reviews: ScorecardRunReview[],
  eventsOf: (task: TaskId) => ScorecardEvent[],
): ReviewRunMeasures {
  const m: ReviewRunMeasures = { runs: 0, clean: 0, asked_changes: 0, merged_unchanged: 0, no_review: 0 };
  for (const run of runs) {
    if (run.outcome === null || !reviewRunCounts(run.outcome)) continue;
    m.runs++;
    const review = reviews.find((r) => r.task_id === run.task_id && r.diff_hash !== null && r.diff_hash === run.diff_hash);
    if (!review) m.no_review++;
    else if (review.kind === 'request_changes') {
      m.asked_changes++;
      if (mergedUnchanged(run, eventsOf(run.task_id))) m.merged_unchanged++;
    } else m.clean++;
  }
  return m;
}

export function reviewRunsText(m: ReviewRunMeasures): string {
  if (!m.runs) return 'review runs: none';
  const parts = [`${m.clean} clean`, `${m.asked_changes} asked for changes, ${m.merged_unchanged} of them merged unchanged by a person`];
  return `review runs: ${m.runs} (${parts.join(', ')}${m.no_review ? `; ${m.no_review} left no review` : ''})`;
}
