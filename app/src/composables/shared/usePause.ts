import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { liveStatusQuery, operationsApi } from '#api/operations.ts';
import { reposApi } from '#api/repos.ts';
import type { Status } from '#api/types.ts';
import { type Actions, trackPending, useActions } from '#composables/shared/useActions.ts';

export function usePause(actions: Actions = useActions()) {
  const statusQ = useQuery(liveStatusQuery());
  const status = computed<Status | null>(() => statusQ.data.value ?? null);
  const { pending: pausing, run } = trackPending(actions);
  const togglePause = () => run(() => (status.value?.paused ? operationsApi.resume() : operationsApi.pause()));
  const resumeDaemon = () => run(() => operationsApi.resume());
  const resumeRepo = (id: number) => run(() => reposApi.resumeRepo(id));
  return { status, pausing, togglePause, resumeDaemon, resumeRepo };
}
