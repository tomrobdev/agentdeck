// Use cases for reviews: a person builds a draft of line comments and an overall note on a task, submits it as a Comment or
// as Request changes, and comments are answered and resolved. Reviews live only in AgentDeck.
import type { Db } from '../../db/index.ts';
import type { ReviewId, TaskId } from '../../domain/shared/id.ts';
import {
  type CommentAction,
  type ReviewComment,
  type ReviewKind,
  type ReviewWithComments,
  commentActionError,
  commentLineError,
  commentSideError,
  commentStatesFor,
  draftError,
  emptyReviewError,
  nextCommentState,
  reviewKindError,
  reviewReason,
} from '../../domain/landing/review.ts';
import { ActionError, number, object, refuse, requireTask, text } from '../input.ts';
import { retryTask } from '../task/tasks.ts';

function requireReview(db: Db, id: ReviewId): ReviewWithComments {
  const review = db.reviewWithComments(id);
  if (!review) throw new ActionError('no such review');
  return review;
}

function requireComment(db: Db, id: number): ReviewComment {
  const comment = db.getComment(id);
  if (!comment) throw new ActionError('no such comment');
  return comment;
}

/** The review a comment belongs to, as it is now. */
const reviewOf = (db: Db, commentId: number): ReviewWithComments => requireReview(db, requireComment(db, commentId).review_id);

/** A task's reviews with their comments, oldest first. */
export function taskReviews(db: Db, taskId: TaskId): ReviewWithComments[] {
  requireTask(db, taskId);
  return db.reviewsForTask(taskId);
}

/** The task's draft review, started if it has none. A task has at most one draft. */
export function startReview(db: Db, taskId: TaskId): ReviewWithComments {
  requireTask(db, taskId);
  const draft = db.draftReviewFor(taskId) ?? db.createReview(taskId);
  return requireReview(db, draft.id);
}

/** Change a draft's overall note. */
export function editReview(db: Db, id: ReviewId, input: { body?: string }): ReviewWithComments {
  const review = requireReview(db, id);
  refuse(draftError(review));
  const body = text(object(input), 'body', { empty: true, raw: true });
  if (body !== undefined && !db.setReviewBody(id, body)) throw new ActionError('the review is already submitted');
  return requireReview(db, id);
}

/** Add a line comment to a draft. `head_commit` is the task's head commit the diff was read at. */
export function addReviewComment(
  db: Db,
  reviewId: ReviewId,
  input: { path: string; line: number; side: string; head_commit: string; body: string },
): ReviewWithComments {
  const review = requireReview(db, reviewId);
  refuse(draftError(review));
  const body = object(input);
  const path = text(body, 'path');
  const head_commit = text(body, 'head_commit');
  const comment = text(body, 'body');
  if (!path) throw new ActionError('path is required');
  if (!head_commit) throw new ActionError('head_commit is required');
  if (!comment) throw new ActionError('body is required');
  const line = number(body, 'line');
  refuse(commentLineError(line));
  refuse(commentSideError(body.side));
  db.addComment({ review_id: reviewId, path, line: line as number, side: body.side as 'old' | 'new', head_commit, body: comment });
  return requireReview(db, reviewId);
}

/** Delete a draft's comment. */
export function deleteReviewComment(db: Db, commentId: number): ReviewWithComments {
  const review = reviewOf(db, commentId);
  refuse(draftError(review));
  db.deleteComment(commentId);
  return requireReview(db, review.id);
}

/**
 * Submit a draft as a Comment or as Request changes. Request changes also sends the task the retry event with the
 * review as its reason (so a done task moves back to queued); if the task can't be retried the review stays a draft.
 */
export function submitReview(db: Db, id: ReviewId, input: { kind: string; body?: string }): ReviewWithComments {
  const review = requireReview(db, id);
  refuse(draftError(review));
  const fields = object(input);
  refuse(reviewKindError(fields.kind));
  const kind = fields.kind as ReviewKind;
  const note = text(fields, 'body', { empty: true, raw: true }) ?? review.body;
  refuse(emptyReviewError(note, review.comments.length));
  if (kind === 'request_changes') retryTask(db, review.task_id, reviewReason(note, review.comments));
  if (!db.submitReview(id, kind, note)) throw new ActionError('the review is already submitted');
  return requireReview(db, id);
}

/** Move a comment of a submitted review: answered, resolved or reopened. */
function moveComment(db: Db, commentId: number, action: CommentAction, answer?: string): ReviewWithComments {
  const comment = requireComment(db, commentId);
  const review = requireReview(db, comment.review_id);
  if (!review.submitted_at) throw new ActionError('the review is still a draft; submit it first');
  refuse(commentActionError(comment.state, action));
  const to = nextCommentState(comment.state, action) as NonNullable<ReturnType<typeof nextCommentState>>;
  if (!db.moveComment(commentId, commentStatesFor(action), to, answer)) throw new ActionError(`the comment is no longer ${comment.state}`);
  return requireReview(db, review.id);
}

export const resolveReviewComment = (db: Db, commentId: number): ReviewWithComments => moveComment(db, commentId, 'resolve');

export const reopenReviewComment = (db: Db, commentId: number): ReviewWithComments => moveComment(db, commentId, 'reopen');
