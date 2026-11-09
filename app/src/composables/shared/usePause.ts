// Pause and the two Resume buttons (the daemon's, a repo's) share one pending state; every other button has its own. The
// status bar, the wait bar and the palette each use it, and the live status they read is one cached query.
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { liveStatusQuery, operationsApi } from '../../api/operations';
import { reposApi } from '../../api/repos';
import type { Status } from '../../api/types';
import { type Actions, trackPending, useActions } from './useActions';

/** App passes the actions it provides, since a component cannot inject what it provides itself. */
export function usePause(actions: Actions = useActions()) {
  const statusQ = useQuery(liveStatusQuery());
  const status = computed<Status | null>(() => statusQ.data.value ?? null);
  const { pending: pausing, run } = trackPending(actions);
  const togglePause = () => run(() => (status.value?.paused ? operationsApi.resume() : operationsApi.pause()));
  const resumeDaemon = () => run(() => operationsApi.resume());
  const resumeRepo = (id: number) => run(() => reposApi.resumeRepo(id));
  return { status, pausing, togglePause, resumeDaemon, resumeRepo };
}
