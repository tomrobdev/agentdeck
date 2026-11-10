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
  openPr: (id: number) => post<OpenPrResult>(`/api/tasks/${id}/open-pr`),
  closePr: (id: number) => post<TaskDetail>(`/api/tasks/${id}/close-pr`),
  fixChecks: (id: number) => post<FixChecksResult>(`/api/tasks/${id}/fix-checks`),
  mergePreview: (id: number) => get<MergePreview>(`/api/tasks/${id}/merge`),
  merge: (id: number, body: MergeRequest) => post<MergeResult>(`/api/tasks/${id}/merge`, body),
  requestMerge: (id: number, body: RequestMergeRequest = {}) => post<RequestMergeResult>(`/api/tasks/${id}/merge-request`, body),
  requestMerges: (ids: number[]) =>
    post<RequestMergesResult>('/api/tasks/merge-requests', { ids: ids.map(asTaskId) } satisfies RequestMergesRequest),
  cancelMergeRequest: (id: number) => del<CancelMergeRequestResult>(`/api/tasks/${id}/merge-request`),
  autoMerge: (id: number, body: AutoMergeRequest) => post<AutoMergeResult>(`/api/tasks/${id}/auto-merge`, body),

  reviews: (id: number) => get<Review[]>(`/api/tasks/${id}/reviews`),
  startReview: (id: number) => post<Review>(`/api/tasks/${id}/reviews`),
  editReview: (id: number, body: string) => post<Review>(`/api/reviews/${id}`, { body } satisfies ReviewPatch),
  addComment: (reviewId: number, c: NewReviewComment) => post<Review>(`/api/reviews/${reviewId}/comments`, c),
  deleteComment: (id: number) => del<Review>(`/api/review-comments/${id}`),
  submitReview: (id: number, body: SubmitReview) => post<Review>(`/api/reviews/${id}/submit`, body),
  resolveComment: (id: number) => post<Review>(`/api/review-comments/${id}/resolve`),
  reopenComment: (id: number) => post<Review>(`/api/review-comments/${id}/reopen`),
};

export const mergePreviewQuery = (id: number) =>
  queryOptions({ queryKey: ['task', id, 'merge'] as const, queryFn: () => landingApi.mergePreview(id), gcTime: 0 });
export const reviewsQuery = (id: number) =>
  queryOptions({ queryKey: ['task', id, 'reviews'] as const, queryFn: () => landingApi.reviews(id) });
