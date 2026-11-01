// Reviews: a task's drafts and submitted reviews, their line comments, and answering and resolving them.
import * as actions from '../../application/actions.ts';
import { type ApiContext, type Route, route } from '../http.ts';

export function routes({ db, scheduler }: ApiContext): Route[] {
  const n = Number;
  return [
    route('GET', /^\/api\/tasks\/(\d+)\/reviews$/, ({ params: [id] }) => actions.taskReviews(db, n(id))),
    route('POST', /^\/api\/tasks\/(\d+)\/reviews$/, ({ params: [id] }) => actions.startReview(db, n(id))),
    route('POST', /^\/api\/reviews\/(\d+)$/, ({ params: [id], body }) => actions.editReview(db, n(id), body)),
    route('POST', /^\/api\/reviews\/(\d+)\/comments$/, ({ params: [id], body }) =>
      actions.addReviewComment(db, n(id), body as Parameters<typeof actions.addReviewComment>[2]),
    ),
    route('POST', /^\/api\/reviews\/(\d+)\/submit$/, ({ params: [id], body }) => {
      const review = actions.submitReview(db, n(id), body as Parameters<typeof actions.submitReview>[2]);
      scheduler.wake(); // Request changes queues the task
      return review;
    }),
    route('POST', /^\/api\/review-comments\/(\d+)$/, ({ params: [id], body }) =>
      actions.editReviewComment(db, n(id), body as Parameters<typeof actions.editReviewComment>[2]),
    ),
    route('DELETE', /^\/api\/review-comments\/(\d+)$/, ({ params: [id] }) => actions.deleteReviewComment(db, n(id))),
    route('POST', /^\/api\/review-comments\/(\d+)\/answer$/, ({ params: [id], body }) =>
      actions.answerReviewComment(db, n(id), body as Parameters<typeof actions.answerReviewComment>[2]),
    ),
    route('POST', /^\/api\/review-comments\/(\d+)\/resolve$/, ({ params: [id] }) => actions.resolveReviewComment(db, n(id))),
    route('POST', /^\/api\/review-comments\/(\d+)\/reopen$/, ({ params: [id] }) => actions.reopenReviewComment(db, n(id))),
  ];
}
