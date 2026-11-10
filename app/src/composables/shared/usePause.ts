import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { liveStatusQuery, operationsApi } from '../../api/operations';
import { reposApi } from '../../api/repos';
import type { Status } from '../../api/types';
import { type Actions, trackPending, useActions } from './useActions';

export function usePause(actions: Actions = useActions()) {
  const statusQ = useQuery(liveStatusQuery());
  const status = computed<Status | null>(() => statusQ.data.value ?? null);
  const { pending: pausing, run } = trackPending(actions);
  const togglePause = () => run(() => (status.value?.paused ? operationsApi.resume() : operationsApi.pause()));
  const resumeDaemon = () => run(() => operationsApi.resume());
  const resumeRepo = (id: number) => run(() => reposApi.resumeRepo(id));
  return { status, pausing, togglePause, resumeDaemon, resumeRepo };
}
