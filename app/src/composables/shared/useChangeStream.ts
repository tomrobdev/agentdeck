// The daemon says when the database changed (GET /api/events, a revision number); refetch what is on screen then.
import { onBeforeUnmount } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { API_BASE, refreshAll } from '../../api/http';

export function useChangeStream() {
  const queryClient = useQueryClient();
  const refresh = () => void refreshAll(queryClient);
  let lastRev: number | null = null;

  const source = new EventSource(`${API_BASE}/api/events`);
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
