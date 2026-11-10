// Reviews of a task's changes: a draft a person builds up in the dashboard, then submits as a comment or a request for changes, or the review a review run leaves (domain/runs/review.ts).
import type { ReviewId, TaskId } from '../../shared/index.ts';

export const REVIEW_KINDS = ['comment', 'request_changes'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const REVIEW_AUTHORS = ['person', 'review_run'] as const;
/** Who made a review: a person in the dashboard, or a review run. A review run stores its own review, never a person's draft. */
export type ReviewAuthor = (typeof REVIEW_AUTHORS)[number];

/**
 * The changes a submitted review read: the task's head commit, and the patch-id of the task's changes against the base
 * branch (`diffHash` on the Workspace port). A sync that only brings in the base keeps the patch-id, so it needs no new
 * review. Each is null when it could not be read (no branch, no base).
 */
export interface ReviewedDiff {
  head_commit: string | null;
  diff_hash: string | null;
}

export const BLOCKING_PREFIX = 'Blocking: ';

export const COMMENT_SIDES = ['old', 'new'] as const;
/** Which side of the diff a comment's line number counts on: the base file (old) or the task's head (new). */
export type CommentSide = (typeof COMMENT_SIDES)[number];

export const COMMENT_STATES = ['open', 'answered', 'resolved'] as const;
export type CommentState = (typeof COMMENT_STATES)[number];

/** One review of a task. A draft has no `submitted_at` and no `kind` yet, and no head or diff: they are read at submit. */
export interface Review extends ReviewedDiff {
  id: ReviewId;
  task_id: TaskId;
  kind: ReviewKind | null;
  by: ReviewAuthor;
  /** The overall note. */
  body: string;
  created_at: string;
  submitted_at: string | null;
}

/** A line comment on the task's diff. */
export interface ReviewComment {
  id: number;
  review_id: ReviewId;
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

export const COMMENT_MOVES: Record<CommentAction, Partial<Record<CommentState, CommentState>>> = {
  answer: { open: 'answered', answered: 'answered' },
  resolve: { open: 'resolved', answered: 'resolved' },
  reopen: { answered: 'open', resolved: 'open' },
};

export function nextCommentState(state: CommentState, action: CommentAction): CommentState | null {
  return COMMENT_MOVES[action][state] ?? null;
}

export function commentStatesFor(action: CommentAction): CommentState[] {
  return Object.keys(COMMENT_MOVES[action]) as CommentState[];
}

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

export function draftError(review: Pick<Review, 'submitted_at'>): string | null {
  return isDraft(review) ? null : 'the review is already submitted';
}

export function emptyReviewError(body: string, comments: number): string | null {
  return body.trim() || comments > 0 ? null : 'a review needs a note or at least one comment';
}

export function submittedRequests(reviews: ReviewWithComments[]): ReviewWithComments[] {
  return reviews.filter((r) => r.kind === 'request_changes' && r.submitted_at !== null);
}

export function commentsToAddress(reviews: ReviewWithComments[]): ReviewComment[] {
  return submittedRequests(reviews)
    .flatMap((r) => r.comments)
    .filter((c) => c.state === 'open')
    .sort((a, b) => a.id - b.id);
}

export function commentLocation(c: Pick<ReviewComment, 'path' | 'line' | 'side'>): string {
  return `${c.path}:${c.line}${c.side === 'old' ? ' (old)' : ''}`;
}

export function reviewReason(body: string, comments: Pick<ReviewComment, 'path' | 'line' | 'side' | 'body'>[]): string {
  const lines = comments.map((c) => `- ${commentLocation(c)}: ${c.body}`);
  return [body.trim(), lines.join('\n')].filter(Boolean).join('\n\n');
}
