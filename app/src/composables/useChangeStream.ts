// The daemon says when the database changed (GET /api/events, a revision number); refetch what is on screen then.
import { onBeforeUnmount } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { API_BASE } from '../api/client';

export function useChangeStream() {
  const queryClient = useQueryClient();
  let lastRev: number | null = null;

  const source = new EventSource(`${API_BASE}/api/events`);
  // Every (re)open: a daemon restart reconnects, and writes may have been missed while it was down.
  source.onopen = () => void queryClient.invalidateQueries();
  source.addEventListener('rev', (e) => {
    let rev: number;
    try {
      rev = (JSON.parse((e as MessageEvent<string>).data) as { rev: number }).rev;
    } catch {
      return;
    }
    if (rev === lastRev) return;
    lastRev = rev;
    void queryClient.invalidateQueries();
  });

  onBeforeUnmount(() => source.close());
}
