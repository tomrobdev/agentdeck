// A task's reviews: the draft being built, and every comment of every review for the diff to show.
import { type Ref, computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { reviewsQuery } from '../../api/landing';
import type { Review, ReviewComment } from '../../api/types';

export type ShownComment = ReviewComment & { draft: boolean; by: Review['by'] };

export function useReviews(taskId: Ref<number>) {
  const q = useQuery(computed(() => reviewsQuery(taskId.value)));
  const reviews = computed(() => q.data.value ?? []);
  const draft = computed<Review | null>(() => reviews.value.find((r) => r.submitted_at === null) ?? null);
  const comments = computed<ShownComment[]>(() =>
    reviews.value.flatMap((r) => r.comments.map((c) => ({ ...c, draft: r.submitted_at === null, by: r.by }))),
  );
  const byPath = computed(() => {
    const out = new Map<string, ShownComment[]>();
    for (const c of comments.value) out.set(c.path, [...(out.get(c.path) ?? []), c]);
    return out;
  });
  const openPaths = computed(() => new Set(comments.value.filter((c) => c.state !== 'resolved').map((c) => c.path)));
  const pending = computed(() => draft.value?.comments.length ?? 0);
  return { reviews, draft, comments, byPath, openPaths, pending };
}
