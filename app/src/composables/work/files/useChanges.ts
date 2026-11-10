import { type Ref, computed, shallowRef, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { changesQuery } from '../../../api/work';
import type { Changes, TaskDetail } from '../../../api/types';

const RUNNING_POLL_MS = 10_000;

export function useChanges(task: Ref<TaskDetail>) {
  const q = useQuery(
    computed(() => ({
      ...changesQuery(task.value.id),
      enabled: !!task.value.branch,
      refetchInterval: task.value.status === 'running' ? RUNNING_POLL_MS : (false as const),
    })),
  );

  const changes = shallowRef<Changes | null>(null);
  const pointsOf = (c: Changes | null | undefined) => JSON.stringify(c?.since_points ?? []);
  watch(
    () => (task.value.branch ? q.data.value : undefined),
    (next) => {
      if (!next) changes.value = null;
      else if (next.head !== changes.value?.head || next.base !== changes.value?.base || pointsOf(next) !== pointsOf(changes.value))
        changes.value = next;
    },
    { immediate: true },
  );

  const error = computed(() =>
    task.value.branch ? (q.error.value?.message ?? '') : 'No branch yet: changes appear once the first run starts.',
  );
  const paths = computed(() => new Set(changes.value?.files.map((f) => f.path) ?? []));
  const isPath = (p: string) => paths.value.has(p);

  return { changes, error, isPath, paths };
}

export function useCommits(taskId: Ref<number>) {
  const q = useQuery(computed(() => ({ ...changesQuery(taskId.value), enabled: false })));
  return { head: computed(() => q.data.value?.head ?? null), base: computed(() => q.data.value?.base ?? null) };
}
