// Reviews and their comments. A draft is edited freely; a submitted review changes only in its comments' states.
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { ReviewId, TaskId } from '../domain/shared/id.ts';
import type { CommentSide, CommentState, Review, ReviewComment, ReviewKind, ReviewWithComments } from '../domain/landing/review.ts';
import type { Orm } from './orm.ts';
import { NOW_SQL } from './sql.ts';
import { reviewComments, reviews } from './tables.ts';

type ReviewRow = typeof reviews.$inferSelect;
type CommentRow = typeof reviewComments.$inferSelect;

const toReview = (row: ReviewRow): Review => ({ ...row, kind: row.kind as ReviewKind | null });
const toComment = (row: CommentRow): ReviewComment => ({ ...row, side: row.side as CommentSide, state: row.state as CommentState });

export function reviewStore(orm: Orm) {
  const commentsOf = (review_id: ReviewId): ReviewComment[] =>
    orm.select().from(reviewComments).where(eq(reviewComments.review_id, review_id)).orderBy(asc(reviewComments.id)).all().map(toComment);

  return {
    /** A new draft for the task. */
    createReview(task_id: TaskId): Review {
      return toReview(orm.insert(reviews).values({ task_id }).returning().get());
    },
    getReview(id: ReviewId): Review | undefined {
      const row = orm.select().from(reviews).where(eq(reviews.id, id)).get();
      return row && toReview(row);
    },
    /** The task's draft, if it has one. */
    draftReviewFor(task_id: TaskId): Review | undefined {
      const row = orm
        .select()
        .from(reviews)
        .where(and(eq(reviews.task_id, task_id), isNull(reviews.submitted_at)))
        .orderBy(asc(reviews.id))
        .get();
      return row && toReview(row);
    },
    /** The task's reviews with their comments, oldest first. */
    reviewsForTask(task_id: TaskId): ReviewWithComments[] {
      const rows = orm.select().from(reviews).where(eq(reviews.task_id, task_id)).orderBy(asc(reviews.id)).all();
      if (!rows.length) return [];
      const comments = orm
        .select()
        .from(reviewComments)
        .where(
          inArray(
            reviewComments.review_id,
            rows.map((r) => r.id),
          ),
        )
        .orderBy(asc(reviewComments.id))
        .all()
        .map(toComment);
      return rows.map((r) => ({ ...toReview(r), comments: comments.filter((c) => c.review_id === r.id) }));
    },
    reviewWithComments(id: ReviewId): ReviewWithComments | undefined {
      const review = this.getReview(id);
      return review && { ...review, comments: commentsOf(id) };
    },
    /** Change a draft's overall note. False when the review is not a draft. */
    setReviewBody(id: ReviewId, body: string): boolean {
      return (
        orm
          .update(reviews)
          .set({ body })
          .where(and(eq(reviews.id, id), isNull(reviews.submitted_at)))
          .run().changes > 0
      );
    },
    /** Submit a draft with its kind and overall note. False when the review is not a draft. */
    submitReview(id: ReviewId, kind: ReviewKind, body: string): boolean {
      return (
        orm
          .update(reviews)
          .set({ kind, body, submitted_at: NOW_SQL })
          .where(and(eq(reviews.id, id), isNull(reviews.submitted_at)))
          .run().changes > 0
      );
    },
    getComment(id: number): ReviewComment | undefined {
      const row = orm.select().from(reviewComments).where(eq(reviewComments.id, id)).get();
      return row && toComment(row);
    },
    addComment(c: Pick<ReviewComment, 'review_id' | 'path' | 'line' | 'side' | 'head_commit' | 'body'>): ReviewComment {
      return toComment(orm.insert(reviewComments).values(c).returning().get());
    },
    /** Delete a comment of a draft. False when it is gone or its review is submitted. */
    deleteComment(id: number): boolean {
      return (
        orm
          .delete(reviewComments)
          .where(
            and(
              eq(reviewComments.id, id),
              inArray(reviewComments.review_id, orm.select({ id: reviews.id }).from(reviews).where(isNull(reviews.submitted_at))),
            ),
          )
          .run().changes > 0
      );
    },
    /** Move a comment of a submitted review to `to`, only from one of the `from` states; `answer` (when given) replaces its answer. */
    moveComment(id: number, from: CommentState[], to: CommentState, answer?: string): boolean {
      return (
        orm
          .update(reviewComments)
          .set({ state: to, updated_at: NOW_SQL, ...(answer === undefined ? {} : { answer }) })
          .where(
            and(
              eq(reviewComments.id, id),
              inArray(reviewComments.state, from),
              inArray(reviewComments.review_id, orm.select({ id: reviews.id }).from(reviews).where(isNotNull(reviews.submitted_at))),
            ),
          )
          .run().changes > 0
      );
    },
  };
}
