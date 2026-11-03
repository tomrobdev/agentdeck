// The daemon says when the database changed (GET /api/events, a revision number); refetch what is on screen then.
import { onBeforeUnmount } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { API_BASE } from '../api/client';
import { isImmutable } from '../api/queries';

export function useChangeStream() {
  const queryClient = useQueryClient();
  // Queries pinned to a commit (diffs, files, trees) can't change with a write; refetching them is wasted work.
  const refresh = () => void queryClient.invalidateQueries({ predicate: (q) => !isImmutable(q.queryKey) });
  let lastRev: number | null = null;

  const source = new EventSource(`${API_BASE}/api/events`);
  // Every (re)open: a daemon restart reconnects, and writes may have been missed while it was down.
  source.onopen = refresh;
  source.addEventListener('rev', (e) => {
    let rev: number;
    try {
      rev = (JSON.parse((e as MessageEvent<string>).data) as { rev: number }).rev;
    } catch {
      return;
    }
    if (rev === lastRev) return;
    lastRev = rev;
    refresh();
  });

  onBeforeUnmount(() => source.close());
}
