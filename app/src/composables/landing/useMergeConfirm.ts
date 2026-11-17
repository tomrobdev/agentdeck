// The merge confirm, opened from a row's button or `m`. After a merge the selection moves to the next row.
import { type Ref, ref } from 'vue';
import type { MergeResult, TaskSummary } from '#api/types.ts';
import { useActions } from '#composables/shared/useActions.ts';

export function useMergeConfirm(order: Ref<TaskSummary[]>, selected: Ref<number | null>) {
  const { refresh, flash } = useActions();
  const merging = ref<{ id: number; next: number | null } | null>(null);
  function startMerge(id: number) {
    const list = order.value;
    const i = list.findIndex((t) => t.id === id);
    merging.value = { id, next: (list[i + 1] ?? list[i - 1])?.id ?? null };
  }
  async function onMerged(result: MergeResult) {
    const next = merging.value?.next ?? null;
    merging.value = null;
    selected.value = next;
    await refresh();
    if (result.syncing) flash(result.syncing);
    if (result.cleanup_error) flash(`Merged, but cleanup failed: ${result.cleanup_error}`);
  }
  function onRequested() {
    merging.value = null;
  }
  return { merging, startMerge, onMerged, onRequested };
}
