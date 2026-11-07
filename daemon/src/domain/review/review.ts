// Reviews made in the dashboard: a draft a person builds up, then submits as a comment or a request for changes.
// Pure rules for how a comment's state moves and which comments a run must address. Nothing here comes from or goes to GitHub.

export const REVIEW_KINDS = ['comment', 'request_changes'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const COMMENT_SIDES = ['old', 'new'] as const;
/** Which side of the diff a comment's line number counts on: the base file (old) or the task's head (new). */
export type CommentSide = (typeof COMMENT_SIDES)[number];

export const COMMENT_STATES = ['open', 'answered', 'resolved'] as const;
export type CommentState = (typeof COMMENT_STATES)[number];

/** One review of a task. A draft has no `submitted_at` and no `kind` yet. */
export interface Review {
  id: number;
  task_id: number;
  kind: ReviewKind | null;
  /** The overall note. */
  body: string;
  created_at: string;
  submitted_at: string | null;
}

/** A line comment on the task's diff. */
export interface ReviewComment {
  id: number;
  review_id: number;
  path: string;
  line: number;
  side: CommentSide;
  /** The task's head commit the comment was made on. */
  head_commit: string;
  body: string;
  /** What the author of the work said back; null until answered. */
  answer: string | null;
  state: CommentState;
  created_at: string;
  updated_at: string;
}

/** A review with its comments, oldest first. */
export type ReviewWithComments = Review & { comments: ReviewComment[] };

export const isDraft = (review: Pick<Review, 'submitted_at'>): boolean => review.submitted_at === null;

export type CommentAction = 'answer' | 'resolve' | 'reopen';

/** Where each action may start and where it leads. Anything not listed is refused. */
export const COMMENT_MOVES: Record<CommentAction, Partial<Record<CommentState, CommentState>>> = {
  answer: { open: 'answered', answered: 'answered' },
  resolve: { open: 'resolved', answered: 'resolved' },
  reopen: { answered: 'open', resolved: 'open' },
};

/** The state `action` leads to from `state`, or null when the action doesn't apply there. */
export function nextCommentState(state: CommentState, action: CommentAction): CommentState | null {
  return COMMENT_MOVES[action][state] ?? null;
}

/** The states a comment may be in for `action` to apply, for a guarded update. */
export function commentStatesFor(action: CommentAction): CommentState[] {
  return Object.keys(COMMENT_MOVES[action]) as CommentState[];
}

/** Why a comment can't take `action` now, or null. */
export function commentActionError(state: CommentState, action: CommentAction): string | null {
  if (nextCommentState(state, action)) return null;
  return action === 'reopen'
    ? `the comment is ${state}, so there is nothing to reopen`
    : `the comment is ${state}, so it can't be ${action === 'answer' ? 'answered' : 'resolved'}`;
}

export function reviewKindError(value: unknown): string | null {
  return REVIEW_KINDS.includes(value as ReviewKind) ? null : `kind must be one of ${REVIEW_KINDS.join(', ')}`;
}

export function commentSideError(value: unknown): string | null {
  return COMMENT_SIDES.includes(value as CommentSide) ? null : `side must be one of ${COMMENT_SIDES.join(', ')}`;
}

export function commentLineError(value: unknown): string | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? null : 'line must be a whole number from 1';
}

/** A review can only be changed (comments added, edited or deleted, note edited) while it is a draft. */
export function draftError(review: Pick<Review, 'submitted_at'>): string | null {
  return isDraft(review) ? null : 'the review is already submitted';
}

/** A review with no note and no comments says nothing. */
export function emptyReviewError(body: string, comments: number): string | null {
  return body.trim() || comments > 0 ? null : 'a review needs a note or at least one comment';
}

/** The submitted Request changes reviews, in the order given. */
export function submittedRequests(reviews: ReviewWithComments[]): ReviewWithComments[] {
  return reviews.filter((r) => r.kind === 'request_changes' && r.submitted_at !== null);
}

/** The comments a run of the task must address: the open ones in submitted request_changes reviews, oldest first. */
export function commentsToAddress(reviews: ReviewWithComments[]): ReviewComment[] {
  return submittedRequests(reviews)
    .flatMap((r) => r.comments)
    .filter((c) => c.state === 'open')
    .sort((a, b) => a.id - b.id);
}

/** Where a comment points, as `path:line` with the side when it is the old file's line. */
export function commentLocation(c: Pick<ReviewComment, 'path' | 'line' | 'side'>): string {
  return `${c.path}:${c.line}${c.side === 'old' ? ' (old)' : ''}`;
}

/** The reason a Request changes review gives the retry event: the overall note, then each comment. */
export function reviewReason(body: string, comments: ReviewComment[]): string {
  const lines = comments.map((c) => `- ${commentLocation(c)}: ${c.body}`);
  return [body.trim(), lines.join('\n')].filter(Boolean).join('\n\n');
}
