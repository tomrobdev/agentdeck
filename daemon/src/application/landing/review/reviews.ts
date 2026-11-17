// Use cases for reviews: a person builds a draft of line comments and an overall note on a task, submits it as a Comment or as Request changes, and comments are answered and resolved.
import type { App } from '../../ports/app.ts';
import type { ReviewId, TaskId } from '../../../domain/shared/index.ts';
import {
  type CommentAction,
  type ReviewComment,
  type ReviewKind,
  type ReviewWithComments,
  type ReviewedDiff,
  commentActionError,
  commentLineError,
  commentSideError,
  commentStatesFor,
  draftError,
  emptyReviewError,
  nextCommentState,
  reviewKindError,
  reviewReason,
} from '../../../domain/landing/index.ts';
import { ActionError, number, object, refuse, requireTask, text } from '../../shared/input.ts';
import { retryTask } from '../person-events.ts';

function requireReview(app: App, id: ReviewId): ReviewWithComments {
  const review = app.reviewWithComments(id);
  if (!review) throw new ActionError('no such review', undefined, 'not_found');
  return review;
}

function requireComment(app: App, id: number): ReviewComment {
  const comment = app.getComment(id);
  if (!comment) throw new ActionError('no such comment', undefined, 'not_found');
  return comment;
}

const reviewOf = (app: App, commentId: number): ReviewWithComments => requireReview(app, requireComment(app, commentId).review_id);

export function taskReviews(app: App, taskId: TaskId): ReviewWithComments[] {
  requireTask(app, taskId);
  return app.reviewsForTask(taskId);
}

export function startReview(app: App, taskId: TaskId): ReviewWithComments {
  requireTask(app, taskId);
  const draft = app.draftReviewFor(taskId) ?? app.createReview(taskId);
  return requireReview(app, draft.id);
}

export function editReview(app: App, id: ReviewId, input: { body?: string }): ReviewWithComments {
  const review = requireReview(app, id);
  refuse(draftError(review), undefined, 'conflict');
  const body = text(object(input), 'body', { empty: true, raw: true });
  if (body !== undefined && !app.setReviewBody(id, body)) throw new ActionError('the review is already submitted', undefined, 'conflict');
  return requireReview(app, id);
}

export function addReviewComment(
  app: App,
  reviewId: ReviewId,
  input: { path: string; line: number; side: string; head_commit: string; body: string },
): ReviewWithComments {
  const review = requireReview(app, reviewId);
  refuse(draftError(review), undefined, 'conflict');
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

export function deleteReviewComment(app: App, commentId: number): ReviewWithComments {
  const review = reviewOf(app, commentId);
  refuse(draftError(review), undefined, 'conflict');
  app.deleteComment(commentId);
  return requireReview(app, review.id);
}

async function reviewedDiff(app: App, taskId: TaskId): Promise<ReviewedDiff> {
  const task = requireTask(app, taskId);
  const repo = app.getRepo(task.repo_id);
  const branch = task.checkout?.branch;
  const head = repo && branch ? await app.workspace.branchHead(repo.path, branch) : null;
  if (!repo || !head) return { head_commit: null, diff_hash: null };
  return { head_commit: head, diff_hash: await app.workspace.diffHash(repo.path, repo.base_branch, head) };
}

export async function submitReview(app: App, id: ReviewId, input: { kind: string; body?: string }): Promise<ReviewWithComments> {
  const review = requireReview(app, id);
  refuse(draftError(review), undefined, 'conflict');
  const fields = object(input);
  refuse(reviewKindError(fields.kind));
  const kind = fields.kind as ReviewKind;
  const note = text(fields, 'body', { empty: true, raw: true }) ?? review.body;
  refuse(emptyReviewError(note, review.comments.length));
  const read = await reviewedDiff(app, review.task_id);
  if (kind === 'request_changes') retryTask(app, review.task_id, { note: reviewReason(note, review.comments) });
  if (!app.submitReview(id, kind, note, read)) throw new ActionError('the review is already submitted', undefined, 'conflict');
  return requireReview(app, id);
}

function moveComment(app: App, commentId: number, action: CommentAction, answer?: string): ReviewWithComments {
  const comment = requireComment(app, commentId);
  const review = requireReview(app, comment.review_id);
  if (!review.submitted_at) throw new ActionError('the review is still a draft; submit it first', undefined, 'conflict');
  refuse(commentActionError(comment.state, action), undefined, 'conflict');
  const to = nextCommentState(comment.state, action) as NonNullable<ReturnType<typeof nextCommentState>>;
  if (!app.moveComment(commentId, commentStatesFor(action), to, answer))
    throw new ActionError(`the comment is no longer ${comment.state}`, undefined, 'conflict');
  return requireReview(app, review.id);
}

export const resolveReviewComment = (app: App, commentId: number): ReviewWithComments => moveComment(app, commentId, 'resolve');

export const reopenReviewComment = (app: App, commentId: number): ReviewWithComments => moveComment(app, commentId, 'reopen');
