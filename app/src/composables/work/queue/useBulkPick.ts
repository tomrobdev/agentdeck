import { type Ref, computed, ref, watch } from 'vue';
import { PERSON_CALLS } from '../../../api/work';
import type { TaskSummary } from '../../../api/types';
import { errorMessage } from '../../../../../daemon/src/domain/shared/index.ts';
import { type BulkAction, type BulkEdit, type BulkResult, bulkActions, bulkMessage } from '../../../lib/work/queue/bulk';
import { canStartMerge } from '../../../../../daemon/src/domain/work/index.ts';
import { useAction, useActions } from '../../shared/useActions';
import { useApprovals } from '../useApprovals';
import { type BulkEditValue, useBulkEdit } from './useBulkEdit';
import { usePicked } from './usePicked';
import { requestedBulk } from './useView';

const VERB: Record<BulkAction, string> = { approve: 'Approve', reject: 'Reject', retry: 'Retry', merge: 'Merge', cancel: 'Cancel' };

export function useBulkPick(tasks: () => TaskSummary[], shown: Ref<TaskSummary[]>) {
  const { run, pending } = useAction();
  const { flash, defer } = useActions();
  const { approve } = useApprovals();
  const { picked, pick, pickMany, toggleGroup, clearPicked, keepIn, setPicked } = usePicked();
  const pickedTasks = computed(() => tasks().filter((t) => picked.value.includes(t.id)));
  const bar = computed(() => bulkActions(pickedTasks.value));
  const bulkMerging = ref<TaskSummary[] | null>(null);
  watch(shown, (s) => keepIn(s.map((t) => t.id)));
  const pickShown = () => pickMany(shown.value.map((t) => t.id));

  async function runAll(action: Exclude<BulkAction, 'merge' | 'approve'>, list: TaskSummary[]) {
    const results: BulkResult[] = [];
    for (const t of list) {
      try {
        await PERSON_CALLS[action](t.id);
        results.push({ id: t.id });
      } catch (e) {
        results.push({ id: t.id, error: errorMessage(e) });
      }
    }
    flash(bulkMessage(action, results));
    setPicked(results.filter((r) => r.error !== undefined).map((r) => r.id));
  }
  async function bulkAct(action: BulkAction) {
    if (action === 'merge') {
      bulkMerging.value = pickedTasks.value;
      return;
    }
    const list = pickedTasks.value;
    if (action === 'reject' || action === 'cancel') {
      const before = picked.value;
      clearPicked();
      defer(
        `${VERB[action]} ${list.length} task${list.length === 1 ? '' : 's'}`,
        () => runAll(action, list),
        () => setPicked(before),
      );
      return;
    }
    if (action === 'approve') {
      await run(async () => {
        const results = await approve(list.map((t) => t.id));
        if (results) setPicked(list.map((t) => t.id).filter((id) => !results.some((r) => r.id === id && r.error === undefined)));
      });
      return;
    }
    await run(() => runAll(action, list));
  }
  const editAll = useBulkEdit(run);
  const bulkEdit = (edit: BulkEdit, value: BulkEditValue, label: string, on?: number) =>
    editAll(pickedTasks.value, edit, value, label, on, true);
  watch(
    [requestedBulk, pickedTasks],
    ([action]) => {
      if (!action || !pickedTasks.value.length) return;
      requestedBulk.value = null;
      if (bar.value.includes(action)) void bulkAct(action);
    },
    { immediate: true },
  );
  function onBulkMerged(merged: number[]) {
    bulkMerging.value = null;
    setPicked(picked.value.filter((id) => !merged.includes(id)));
  }
  function mergeAll(ids: number[]) {
    bulkMerging.value = tasks().filter((t) => ids.includes(t.id) && canStartMerge(t));
  }

  return {
    picked,
    bar,
    bulkMerging,
    pending,
    pick,
    pickMany,
    pickShown,
    toggleGroup,
    clearPicked,
    bulkAct,
    bulkEdit,
    onBulkMerged,
    mergeAll,
  };
}
