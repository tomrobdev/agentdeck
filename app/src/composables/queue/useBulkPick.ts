// Bulk selection in every view: `x` or shift-click picks, and the bar offers what every picked task allows. The picks
// themselves are shared (usePicked); this adds the bar's actions and the bulk merge.
import { type Ref, computed, ref, watch } from 'vue';
import { PERSON_CALLS } from '../../api/client';
import type { TaskSummary } from '../../api/types';
import { errorMessage } from '../../../../daemon/src/domain/shared/index.ts';
import { type BulkAction, type BulkEdit, type BulkResult, bulkActions, bulkMessage } from '../../lib/queue/bulk';
import { canStartMerge } from '../../lib/task/task-view';
import { useAction, useActions } from '../shared/useActions';
import { useApprovals } from '../task/useApprovals';
import { type BulkEditValue, useBulkEdit } from './useBulkEdit';
import { usePicked } from './usePicked';
import { requestedBulk } from '../shared/useView';

const VERB: Record<BulkAction, string> = { approve: 'Approve', reject: 'Reject', retry: 'Retry', merge: 'Merge', cancel: 'Cancel' };

export function useBulkPick(tasks: () => TaskSummary[], shown: Ref<TaskSummary[]>) {
  const { run, pending } = useAction();
  const { flash, defer } = useActions();
  const { approve } = useApprovals();
  const { picked, pick, pickMany, toggleGroup, clearPicked, keepIn, setPicked } = usePicked();
  const pickedTasks = computed(() => tasks().filter((t) => picked.value.includes(t.id)));
  const bar = computed(() => bulkActions(pickedTasks.value));
  // The tasks the bulk merge was confirmed for, fixed while it runs so a refresh can't change its list.
  const bulkMerging = ref<TaskSummary[] | null>(null);
  // Drop picks for tasks that left the filtered set (deleted, filtered out). A collapsed group is still in the set.
  // `order` skips collapsed groups, so the filtered set is `shown`.
  watch(shown, (s) => keepIn(s.map((t) => t.id)));
  /** X: every task the filter shows, collapsed groups too. */
  const pickShown = () => pickMany(shown.value.map((t) => t.id));

  /** Calls every task, whatever an earlier one did, says what happened, and leaves the failed ones picked. */
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
    // A reject or cancel can be undone for 5 seconds: the calls wait, and the picks come back on Undo.
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
      // The approve gate may open a dialog and says what happened itself. A task not approved (failed, unticked) stays picked.
      await run(async () => {
        const results = await approve(list.map((t) => t.id));
        if (results) setPicked(list.map((t) => t.id).filter((id) => !results.some((r) => r.id === id && r.error === undefined)));
      });
      return;
    }
    await run(() => runAll(action, list));
  }
  const editAll = useBulkEdit(run);
  /** Edits every picked task that allows it; see `useBulkEdit`. */
  const bulkEdit = (edit: BulkEdit, value: BulkEditValue, label: string, on?: number) =>
    editAll(pickedTasks.value, edit, value, label, on, true);
  // The palette asks for a bulk action; apply it when it arrives (also when the queue mounts after the palette sent it).
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
  /** "Merge all" on the Review group: the bulk merge confirm, for every PR in review that may start a merge. */
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
