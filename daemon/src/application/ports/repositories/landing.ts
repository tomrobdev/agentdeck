// Landing's repository: reviews and their line comments.
import type { ReviewId, TaskId } from '#domain/shared/index.ts';
import type { CommentState, Review, ReviewComment, ReviewKind, ReviewWithComments, ReviewedDiff } from '#domain/landing/index.ts';

export interface ReviewRepository {
  createReview(task_id: TaskId): Review;
  draftReviewFor(task_id: TaskId): Review | undefined;
  addRunReview(task_id: TaskId, kind: ReviewKind, body: string, read: { head_commit: string; diff_hash: string }): Review;
  reviewsForTask(task_id: TaskId): ReviewWithComments[];
  reviewWithComments(id: ReviewId): ReviewWithComments | undefined;
  setReviewBody(id: ReviewId, body: string): boolean;
  submitReview(id: ReviewId, kind: ReviewKind, body: string, read: ReviewedDiff): boolean;
  getComment(id: number): ReviewComment | undefined;
  addComment(c: Pick<ReviewComment, 'review_id' | 'path' | 'line' | 'side' | 'head_commit' | 'body'>): ReviewComment;
  deleteComment(id: number): boolean;
  moveComment(id: number, from: CommentState[], to: CommentState, answer?: string): boolean;
}
