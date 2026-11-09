// Landing: pull requests, merging and reviews.
import { queryOptions } from '@tanstack/vue-query';
import { asTaskId } from '../../../daemon/src/domain/shared/index.ts';
import { del, get, post } from './http.ts';
import type {
  AutoMergeRequest,
  AutoMergeResult,
  CancelMergeRequestResult,
  FixChecksResult,
  MergePreview,
  MergeRequest,
  MergeResult,
  NewReviewComment,
  OpenPrResult,
  RequestMergeRequest,
  RequestMergeResult,
  RequestMergesRequest,
  RequestMergesResult,
  Review,
  ReviewPatch,
  SubmitReview,
  TaskDetail,
} from './types.ts';

export const landingApi = {
  // ---- Pull requests and merging
  /** Push a done task's branch and open its PR (one that failed to open, or was closed); refused with the reason as the error. */
  openPr: (id: number) => post<OpenPrResult>(`/api/tasks/${id}/open-pr`),
  closePr: (id: number) => post<TaskDetail>(`/api/tasks/${id}/close-pr`),
  /** Retry the task with its PR's failing checks, and their logs, in the note; refused with the reason as the error. */
  fixChecks: (id: number) => post<FixChecksResult>(`/api/tasks/${id}/fix-checks`),
  mergePreview: (id: number) => get<MergePreview>(`/api/tasks/${id}/merge`),
  merge: (id: number, body: MergeRequest) => post<MergeResult>(`/api/tasks/${id}/merge`, body),
  /** Ask the daemon to merge the task's PR once it is ready; the answer is at once. */
  requestMerge: (id: number, body: RequestMergeRequest = {}) => post<RequestMergeResult>(`/api/tasks/${id}/merge-request`, body),
  /** Request these tasks' merges, each with its own method; the ones it could not request come back with why. */
  requestMerges: (ids: number[]) =>
    post<RequestMergesResult>('/api/tasks/merge-requests', { ids: ids.map(asTaskId) } satisfies RequestMergesRequest),
  /** Drop the task's merge request; the PR stays open. */
  cancelMergeRequest: (id: number) => del<CancelMergeRequestResult>(`/api/tasks/${id}/merge-request`),
  /** Let the daemon merge the task's PR on its own (true), not (false), or follow the repo (null). */
  autoMerge: (id: number, body: AutoMergeRequest) => post<AutoMergeResult>(`/api/tasks/${id}/auto-merge`, body),

  // ---- Reviews
  reviews: (id: number) => get<Review[]>(`/api/tasks/${id}/reviews`),
  /** The task's draft review, started if it has none. */
  startReview: (id: number) => post<Review>(`/api/tasks/${id}/reviews`),
  /** Change a draft's overall note. */
  editReview: (id: number, body: string) => post<Review>(`/api/reviews/${id}`, { body } satisfies ReviewPatch),
  addComment: (reviewId: number, c: NewReviewComment) => post<Review>(`/api/reviews/${reviewId}/comments`, c),
  deleteComment: (id: number) => del<Review>(`/api/review-comments/${id}`),
  /** Request changes also retries the task with the review as the reason. */
  submitReview: (id: number, body: SubmitReview) => post<Review>(`/api/reviews/${id}/submit`, body),
  resolveComment: (id: number) => post<Review>(`/api/review-comments/${id}/resolve`),
  reopenComment: (id: number) => post<Review>(`/api/review-comments/${id}/reopen`),
};

/** Read from GitHub just before a merge, so a reopened dialog never starts from an old copy (gcTime 0). */
export const mergePreviewQuery = (id: number) =>
  queryOptions({ queryKey: ['task', id, 'merge'] as const, queryFn: () => landingApi.mergePreview(id), gcTime: 0 });
export const reviewsQuery = (id: number) =>
  queryOptions({ queryKey: ['task', id, 'reviews'] as const, queryFn: () => landingApi.reviews(id) });
