// Reviews: a task's drafts and submitted reviews, their line comments, and answering and resolving them.
import * as actions from '#application/actions.ts';
import type { Review } from '#api/contract/landing.ts';
import { type ApiContext, type Route, reviewIdParam, route, taskIdParam } from '#api/http.ts';

export function routes({ db }: ApiContext): Route[] {
  const n = Number;
  return [
    route<Review[]>('GET', /^\/api\/tasks\/(\d+)\/reviews$/, ({ params: [id] }) => actions.taskReviews(db, taskIdParam(id))),
    route<Review>('POST', /^\/api\/tasks\/(\d+)\/reviews$/, ({ params: [id] }) => actions.startReview(db, taskIdParam(id))),
    route<Review>('POST', /^\/api\/reviews\/(\d+)$/, ({ params: [id], body }) => actions.editReview(db, reviewIdParam(id), body)),
    route<Review>('POST', /^\/api\/reviews\/(\d+)\/comments$/, ({ params: [id], body }) =>
      actions.addReviewComment(db, reviewIdParam(id), body as Parameters<typeof actions.addReviewComment>[2]),
    ),
    route<Review>('POST', /^\/api\/reviews\/(\d+)\/submit$/, ({ params: [id], body }) =>
      actions.submitReview(db, reviewIdParam(id), body as Parameters<typeof actions.submitReview>[2]),
    ),
    route<Review>('DELETE', /^\/api\/review-comments\/(\d+)$/, ({ params: [id] }) => actions.deleteReviewComment(db, n(id))),
    route<Review>('POST', /^\/api\/review-comments\/(\d+)\/resolve$/, ({ params: [id] }) => actions.resolveReviewComment(db, n(id))),
    route<Review>('POST', /^\/api\/review-comments\/(\d+)\/reopen$/, ({ params: [id] }) => actions.reopenReviewComment(db, n(id))),
  ];
}
