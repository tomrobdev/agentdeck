// A task's changes follow its branch: fetched on open and whenever the task moves.
import { type Ref, computed, onBeforeUnmount, ref, watch } from 'vue';
import { type Changes, type TaskDetail, api } from './api';

export function useChanges(task: Ref<TaskDetail>) {
  const changes = ref<Changes | null>(null);
  const error = ref('');

  async function load() {
    const t = task.value;
    if (!t.branch) {
      changes.value = null;
      error.value = 'No branch yet: changes appear once the first run starts.';
      return;
    }
    try {
      const next = await api.changes(t.id);
      error.value = '';
      // Same commits, same changes: keep the object so nothing downstream rebuilds.
      if (next.head === changes.value?.head && next.base === changes.value?.base) return;
      changes.value = next;
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  // Separate sources, so a poll that returns the same values doesn't refetch.
  watch(
    [() => task.value.id, () => task.value.updated_at, () => task.value.branch],
    ([id], before) => {
      if (before && id !== before[0]) changes.value = null;
      load();
    },
    { immediate: true },
  );

  // A running task commits without changing status, so check its branch every 10 s.
  const timer = window.setInterval(() => task.value.status === 'running' && load(), 10_000);
  onBeforeUnmount(() => clearInterval(timer));

  const paths = computed(() => new Set(changes.value?.files.map((f) => f.path) ?? []));
  const isPath = (p: string) => paths.value.has(p);

  return { changes, error, isPath, paths };
}
