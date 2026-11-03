// Reviews: a task's drafts and submitted reviews, their line comments, and answering and resolving them.
import * as actions from '../../application/actions.ts';
import type * as C from '../contract.ts';
import { type ApiContext, type Route, route } from '../http.ts';

export function routes({ db }: ApiContext): Route[] {
  const n = Number;
  return [
    route<C.Review[]>('GET', /^\/api\/tasks\/(\d+)\/reviews$/, ({ params: [id] }) => actions.taskReviews(db, n(id))),
    route<C.Review>('POST', /^\/api\/tasks\/(\d+)\/reviews$/, ({ params: [id] }) => actions.startReview(db, n(id))),
    route<C.Review>('POST', /^\/api\/reviews\/(\d+)$/, ({ params: [id], body }) => actions.editReview(db, n(id), body)),
    route<C.Review>('POST', /^\/api\/reviews\/(\d+)\/comments$/, ({ params: [id], body }) =>
      actions.addReviewComment(db, n(id), body as Parameters<typeof actions.addReviewComment>[2]),
    ),
    route<C.Review>('POST', /^\/api\/reviews\/(\d+)\/submit$/, ({ params: [id], body }) =>
      actions.submitReview(db, n(id), body as Parameters<typeof actions.submitReview>[2]),
    ),
    route<C.Review>('DELETE', /^\/api\/review-comments\/(\d+)$/, ({ params: [id] }) => actions.deleteReviewComment(db, n(id))),
    route<C.Review>('POST', /^\/api\/review-comments\/(\d+)\/resolve$/, ({ params: [id] }) => actions.resolveReviewComment(db, n(id))),
    route<C.Review>('POST', /^\/api\/review-comments\/(\d+)\/reopen$/, ({ params: [id] }) => actions.reopenReviewComment(db, n(id))),
  ];
}
