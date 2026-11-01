// A task's changes follow its branch: fetched on open and whenever the task moves.
import { type Ref, computed, shallowRef, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { type Changes, type TaskDetail, changesQuery } from '../api';

/** A running task commits without changing status, so its branch is checked every 10 s. */
const RUNNING_POLL_MS = 10_000;

export function useChanges(task: Ref<TaskDetail>) {
  const q = useQuery(
    computed(() => ({
      ...changesQuery(task.value.id),
      enabled: !!task.value.branch,
      refetchInterval: task.value.status === 'running' ? RUNNING_POLL_MS : (false as const),
    })),
  );

  // Same commits, same changes: keep the object so nothing downstream rebuilds.
  const changes = shallowRef<Changes | null>(null);
  watch(
    () => (task.value.branch ? q.data.value : undefined),
    (next) => {
      if (!next) changes.value = null;
      else if (next.head !== changes.value?.head || next.base !== changes.value?.base) changes.value = next;
    },
    { immediate: true },
  );

  // Separate sources, so a poll that returns the same values doesn't refetch.
  watch([() => task.value.updated_at, () => task.value.branch], () => {
    if (task.value.branch) q.refetch();
  });

  const error = computed(() =>
    task.value.branch ? (q.error.value?.message ?? '') : 'No branch yet: changes appear once the first run starts.',
  );
  const paths = computed(() => new Set(changes.value?.files.map((f) => f.path) ?? []));
  const isPath = (p: string) => paths.value.has(p);

  return { changes, error, isPath, paths };
}

/** The head and base commits of a task, read from what useChanges already fetched (this fetches nothing). */
export function useCommits(taskId: Ref<number>) {
  const q = useQuery(computed(() => ({ ...changesQuery(taskId.value), enabled: false })));
  return { head: computed(() => q.data.value?.head ?? null), base: computed(() => q.data.value?.base ?? null) };
}
