// Auto-merge's review gate, in a repo with auto_review on: the review run's judgement of the PR's changes, or a person's.
// Pure: no I/O.
import { cut, oneLine, plural } from '../shared/index.ts';
import type { MergeReasons } from './merge.ts';
import { BLOCKING_PREFIX, type ReviewComment, type ReviewWithComments, commentLocation, submittedRequests } from './review.ts';

/** A run of the task as the gate reads it: its kind, the changes it was started to read, and how it ended (null while it runs). */
export interface ReviewRunRead {
  kind: string;
  diff_hash: string | null;
  outcome: string | null;
}

/**
 * The outcomes that end a review run without it counting: a rate limit or a daemon restart stopped it before it
 * answered, so another starts for the same changes.
 */
const GIVEN_BACK = ['rate_limited', 'interrupted'];

/** Whether a review run that ended `outcome` (null while it runs) counts as the review run of its changes. */
export const reviewRunCounts = (outcome: string | null): boolean => !GIVEN_BACK.includes(outcome ?? '');

/** The review runs that read, or are reading, the changes whose patch-id is `diffHash`, oldest first. */
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

/** A comment's ask in a few words: where it points and what it says, without the review run's "Blocking: ". */
const askText = (c: Pick<ReviewComment, 'path' | 'line' | 'side' | 'body'>): string =>
  `${commentLocation(c)}: ${cut(oneLine(c.body.startsWith(BLOCKING_PREFIX) ? c.body.slice(BLOCKING_PREFIX.length) : c.body), 200)}`;

/** What a Request changes review asks first: its first blocking line comment, else its note. */
function firstAsk(review: ReviewWithComments): string {
  const blocking = review.by === 'review_run' ? review.comments.filter((c) => c.body.startsWith(BLOCKING_PREFIX)) : review.comments;
  const first = blocking[0];
  return first ? askText(first) : cut(oneLine(review.body), 200) || 'no note';
}

/**
 * The asks of earlier changes a worker left open: the open line comments of Request changes reviews of other changes
 * than `diffHash` (a worker ran on them since), a person's every comment and a review run's blocking ones. A review
 * run's comment that does not block is a suggestion, and does not wait for an answer.
 */
export function unansweredAsks(reviews: ReviewWithComments[], diffHash: string): ReviewComment[] {
  return submittedRequests(reviews)
    .filter((r) => r.diff_hash !== diffHash)
    .flatMap((r) => r.comments.filter((c) => c.state === 'open' && (r.by === 'person' || c.body.startsWith(BLOCKING_PREFIX))));
}

/**
 * What the review gate adds to auto-merge's check, in a repo with auto_review on. A person's submitted review of these
 * changes counts over the review run's: theirs decides, clean when it is a Comment. Otherwise the latest review run's
 * review of these changes: one that asked for changes needs a person, its first finding told; a clean one adds nothing.
 * With no review yet, the gate waits while a review run is to start or is reading the changes; one that ended with no
 * review (it failed, answered garbage or was stopped) needs a person, since no other starts for the same changes.
 * Changes whose patch-id could not be worked out can't be read by a review run, so they need a person too. And the
 * open asks of earlier reviews a worker left unanswered (`unansweredAsks`) need a person: a clean review run of the new
 * changes never saw them.
 */
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
