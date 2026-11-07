// Bulk selection, in the list only: `x` or shift-click picks, and the bar offers what every picked task allows.
import { type Ref, computed, ref, watch } from 'vue';
import { PERSON_CALLS, type TaskSummary } from '../api';
import { errorMessage } from '../../../daemon/src/domain/shared/text.ts';
import { type BulkAction, bulkActions, idRange } from '../lib/bulk';
import { canStartMerge } from '../lib/taskView';
import { useAction } from './useActions';

export function useBulkPick(tasks: () => TaskSummary[], order: Ref<TaskSummary[]>) {
  const { run, pending } = useAction();
  const picked = ref<number[]>([]);
  const anchor = ref<number | null>(null);
  const pickedTasks = computed(() => tasks().filter((t) => picked.value.includes(t.id)));
  const bar = computed(() => bulkActions(pickedTasks.value));
  // The tasks the bulk merge was confirmed for, fixed while it runs so a refresh can't change its list.
  const bulkMerging = ref<TaskSummary[] | null>(null);
  function pick(id: number, range: boolean) {
    const ids = range
      ? idRange(
          order.value.map((t) => t.id),
          anchor.value,
          id,
        )
      : [id];
    if (range) picked.value = [...new Set([...picked.value, ...ids])];
    else picked.value = picked.value.includes(id) ? picked.value.filter((p) => p !== id) : [...picked.value, id];
    anchor.value = id;
  }
  function clearPicked() {
    picked.value = [];
    anchor.value = null;
  }
  // Drop picks for tasks that left the list (deleted, filtered out).
  watch(order, (o) => {
    const ids = new Set<number>(o.map((t) => t.id));
    if (picked.value.some((id) => !ids.has(id))) picked.value = picked.value.filter((id) => ids.has(id));
  });
  async function bulkAct(action: BulkAction) {
    if (action === 'merge') {
      bulkMerging.value = pickedTasks.value;
      return;
    }
    const tasks = pickedTasks.value;
    const ok = await run(async () => {
      for (const t of tasks) {
        try {
          await PERSON_CALLS[action](t.id);
        } catch (e) {
          throw new Error(`#${t.id}: ${errorMessage(e)}`);
        }
      }
    });
    if (ok) clearPicked();
  }
  function onBulkMerged(merged: number[]) {
    bulkMerging.value = null;
    picked.value = picked.value.filter((id) => !merged.includes(id));
  }
  /** "Merge all" on the Review group: the bulk merge confirm, for every PR in review that may start a merge. */
  function mergeAll(ids: number[]) {
    bulkMerging.value = tasks().filter((t) => ids.includes(t.id) && canStartMerge(t));
  }

  return { picked, bar, bulkMerging, pending, pick, clearPicked, bulkAct, onBulkMerged, mergeAll };
}
