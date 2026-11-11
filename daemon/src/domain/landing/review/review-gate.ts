// Auto-merge's review gate, in a repo with auto_review on: the review run's judgement of the PR's changes, or a person's.
import { cut, oneLine, plural } from '#domain/shared/index.ts';
import type { MergeReasons } from '#domain/landing/merge/merge.ts';
import {
  BLOCKING_PREFIX,
  type ReviewComment,
  type ReviewWithComments,
  commentLocation,
  submittedRequests,
} from '#domain/landing/review/review.ts';

/** A run of the task as the gate reads it: its kind, the changes it was started to read, and how it ended (null while it runs). */
export interface ReviewRunRead {
  kind: string;
  diff_hash: string | null;
  outcome: string | null;
}

const GIVEN_BACK = ['rate_limited', 'interrupted'];

export const reviewRunCounts = (outcome: string | null): boolean => !GIVEN_BACK.includes(outcome ?? '');

export function countedReviewRuns<R extends ReviewRunRead>(runs: R[], diffHash: string): R[] {
  return runs.filter((r) => r.kind === 'review' && r.diff_hash === diffHash && reviewRunCounts(r.outcome));
}

/** What the review gate reads about a done task's PR. */
export interface ReviewFacts {
  /** The patch-id of the PR's changes against the base at its head (`diffHash`); null when it could not be worked out. */
  diff_hash: string | null;
  /** The task's reviews, oldest first. */
  reviews: ReviewWithComments[];
  /** The task's runs; only its review runs are read. */
  runs: ReviewRunRead[];
}

const askText = (c: Pick<ReviewComment, 'path' | 'line' | 'side' | 'body'>): string =>
  `${commentLocation(c)}: ${cut(oneLine(c.body.startsWith(BLOCKING_PREFIX) ? c.body.slice(BLOCKING_PREFIX.length) : c.body), 200)}`;

function firstAsk(review: ReviewWithComments): string {
  const blocking = review.by === 'review_run' ? review.comments.filter((c) => c.body.startsWith(BLOCKING_PREFIX)) : review.comments;
  const first = blocking[0];
  return first ? askText(first) : cut(oneLine(review.body), 200) || 'no note';
}

export function unansweredAsks(reviews: ReviewWithComments[], diffHash: string): ReviewComment[] {
  return submittedRequests(reviews)
    .filter((r) => r.diff_hash !== diffHash)
    .flatMap((r) => r.comments.filter((c) => c.state === 'open' && (r.by === 'person' || c.body.startsWith(BLOCKING_PREFIX))));
}

export function reviewGate({ diff_hash, reviews, runs }: ReviewFacts): MergeReasons {
  const gate: MergeReasons = { never: [], wait: [] };
  if (!diff_hash) {
    gate.never.push({ kind: 'review_unread', text: "the changes could not be read at the PR's head, so no review run can read them" });
    return gate;
  }
  const read = reviews.filter((r) => r.submitted_at !== null && r.diff_hash === diff_hash);
  const person = read.filter((r) => r.by === 'person').at(-1);
  if (person) {
    if (person.kind === 'request_changes')
      gate.never.push({ kind: 'review_blocking', text: `a person asked for changes: ${firstAsk(person)}` });
    return gate;
  }
  const review = read.filter((r) => r.by === 'review_run').at(-1);
  if (review?.kind === 'request_changes')
    gate.never.push({ kind: 'review_blocking', text: `the review run asked for changes: ${firstAsk(review)}` });
  else if (!review) {
    const counted = countedReviewRuns(runs, diff_hash);
    if (counted.some((r) => r.outcome !== null))
      gate.never.push({ kind: 'review_failed', text: 'the review run of these changes left no review, and no other starts for them' });
    else
      gate.wait.push({
        kind: 'review_pending',
        text: counted.length ? 'the review run is reading these changes' : 'the review run has not read these changes',
      });
  }
  const open = unansweredAsks(reviews, diff_hash);
  if (open.length)
    gate.never.push({
      kind: 'review_unanswered',
      text: `the worker left ${plural(open.length, 'review comment')} unanswered: ${askText(open[0])}${open.length > 1 ? ` and ${open.length - 1} more` : ''}`,
    });
  return gate;
}
