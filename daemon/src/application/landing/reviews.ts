// Use cases for reviews: a person builds a draft of line comments and an overall note on a task, submits it as a Comment or
// as Request changes, and comments are answered and resolved. Reviews live only in AgentDeck.
import type { App } from '../ports/app.ts';
import type { ReviewId, TaskId } from '../../domain/shared/index.ts';
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
} from '../../domain/landing/index.ts';
import { ActionError, number, object, refuse, requireTask, text } from '../shared/input.ts';
import { retryTask } from '../work/tasks.ts';

function requireReview(app: App, id: ReviewId): ReviewWithComments {
  const review = app.reviewWithComments(id);
  if (!review) throw new ActionError('no such review');
  return review;
}

function requireComment(app: App, id: number): ReviewComment {
  const comment = app.getComment(id);
  if (!comment) throw new ActionError('no such comment');
  return comment;
}

/** The review a comment belongs to, as it is now. */
const reviewOf = (app: App, commentId: number): ReviewWithComments => requireReview(app, requireComment(app, commentId).review_id);

/** A task's reviews with their comments, oldest first. */
export function taskReviews(app: App, taskId: TaskId): ReviewWithComments[] {
  requireTask(app, taskId);
  return app.reviewsForTask(taskId);
}

/** The task's draft review, started if it has none. A task has at most one draft. */
export function startReview(app: App, taskId: TaskId): ReviewWithComments {
  requireTask(app, taskId);
  const draft = app.draftReviewFor(taskId) ?? app.createReview(taskId);
  return requireReview(app, draft.id);
}

/** Change a draft's overall note. */
export function editReview(app: App, id: ReviewId, input: { body?: string }): ReviewWithComments {
  const review = requireReview(app, id);
  refuse(draftError(review));
  const body = text(object(input), 'body', { empty: true, raw: true });
  if (body !== undefined && !app.setReviewBody(id, body)) throw new ActionError('the review is already submitted');
  return requireReview(app, id);
}

/** Add a line comment to a draft. `head_commit` is the task's head commit the diff was read at. */
export function addReviewComment(
  app: App,
  reviewId: ReviewId,
  input: { path: string; line: number; side: string; head_commit: string; body: string },
): ReviewWithComments {
  const review = requireReview(app, reviewId);
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
  app.addComment({ review_id: reviewId, path, line: line as number, side: body.side as 'old' | 'new', head_commit, body: comment });
  return requireReview(app, reviewId);
}

/** Delete a draft's comment. */
export function deleteReviewComment(app: App, commentId: number): ReviewWithComments {
  const review = reviewOf(app, commentId);
  refuse(draftError(review));
  app.deleteComment(commentId);
  return requireReview(app, review.id);
}

/**
 * Submit a draft as a Comment or as Request changes. Request changes also sends the task the retry event with the
 * review as its reason (so a done task moves back to queued); if the task can't be retried the review stays a draft.
 */
export function submitReview(app: App, id: ReviewId, input: { kind: string; body?: string }): ReviewWithComments {
  const review = requireReview(app, id);
  refuse(draftError(review));
  const fields = object(input);
  refuse(reviewKindError(fields.kind));
  const kind = fields.kind as ReviewKind;
  const note = text(fields, 'body', { empty: true, raw: true }) ?? review.body;
  refuse(emptyReviewError(note, review.comments.length));
  if (kind === 'request_changes') retryTask(app, review.task_id, reviewReason(note, review.comments));
  if (!app.submitReview(id, kind, note)) throw new ActionError('the review is already submitted');
  return requireReview(app, id);
}

/** Move a comment of a submitted review: answered, resolved or reopened. */
function moveComment(app: App, commentId: number, action: CommentAction, answer?: string): ReviewWithComments {
  const comment = requireComment(app, commentId);
  const review = requireReview(app, comment.review_id);
  if (!review.submitted_at) throw new ActionError('the review is still a draft; submit it first');
  refuse(commentActionError(comment.state, action));
  const to = nextCommentState(comment.state, action) as NonNullable<ReturnType<typeof nextCommentState>>;
  if (!app.moveComment(commentId, commentStatesFor(action), to, answer)) throw new ActionError(`the comment is no longer ${comment.state}`);
  return requireReview(app, review.id);
}

export const resolveReviewComment = (app: App, commentId: number): ReviewWithComments => moveComment(app, commentId, 'resolve');

export const reopenReviewComment = (app: App, commentId: number): ReviewWithComments => moveComment(app, commentId, 'reopen');
