import { type Ref, ref } from 'vue';
import { runsApi } from '#api/runs.ts';
import type { TaskSummary } from '#api/types.ts';
import { syncLine } from '#lib/landing/landing-wording.ts';
import type { BoardMove } from '#lib/work/queue/board-move.ts';
import { buildsOnChain } from '#lib/work/queue/bulk.ts';
import { stepSelection } from '#lib/work/queue/selection.ts';
import { quickRetry } from '#lib/work/task-view.ts';
import { type PersonEvent, canStartMerge, personEvents } from '#daemon/domain/work/index.ts';
import { useMergeConfirm } from '#composables/landing/useMergeConfirm.ts';
import { useActions } from '#composables/shared/useActions.ts';
import { useHotkeys } from '#composables/shared/useHotkeys.ts';
import { openPanel } from '#composables/shared/useShell.ts';
import { useEditKeys } from '#composables/work/useEditKeys.ts';
import { useBulkPick } from '#composables/work/queue/useBulkPick.ts';
import { useQueueDisplay } from '#composables/work/queue/useQueueDisplay.ts';

interface QueueEmit {
  (e: 'open', id: number): void;
  (e: 'act', kind: PersonEvent, id: number): void;
}

export function useQueueView(tasks: () => TaskSummary[], selected: Ref<number | null>, emit: QueueEmit) {
  const { display, filters, shown, groups, order, toggleGroup, nextMode } = useQueueDisplay(tasks);
  const bulk = useBulkPick(tasks, shown);
  const { picked, pick, pickMany, pickShown, clearPicked } = bulk;
  const orderIds = () => order.value.map((t) => t.id);
  const pickChain = (id: number) => pickMany(buildsOnChain(shown.value, id));

  function step(by: number) {
    const next = stepSelection(orderIds(), selected.value, by);
    if (next !== null) selected.value = next;
  }

  const { merging, startMerge, onMerged, onRequested } = useMergeConfirm(order, selected);
  const { flash, run } = useActions();

  const peek = ref(false);

  async function sync(id: number) {
    if (tasks().find((t) => t.id === id)?.sync) return;
    let done = '';
    const ok = await run(async () => {
      const r = await runsApi.sync(id);
      done = `#${id}: ${syncLine(r)}${r.push_error ? ` Could not push: ${r.push_error}` : ''}`;
    });
    if (ok) flash(done);
  }
  function act(kind: BoardMove | 'sync', id: number) {
    const task = tasks().find((t) => t.id === id);
    if (kind === 'merge') {
      if (task && canStartMerge(task)) startMerge(id);
    } else if (kind === 'sync') void sync(id);
    else emit('act', kind, id);
  }

  const selectedTask = () => tasks().find((x) => x.id === selected.value);
  const edits = useEditKeys('queue', () => selected.value);
  const Q = 'queue' as const;
  useHotkeys({
    j: { label: 'Next task', scope: Q, run: () => step(1) },
    ArrowDown: { label: 'Next task', scope: Q, run: () => step(1) },
    k: { label: 'Previous task', scope: Q, run: () => step(-1) },
    ArrowUp: { label: 'Previous task', scope: Q, run: () => step(-1) },
    ' ': {
      label: 'Peek at the task',
      scope: Q,
      run: () => {
        if (display.value.mode !== 'list') return;
        if (selected.value === null && order.value.length) selected.value = order.value[0].id;
        peek.value = !peek.value;
      },
    },
    x: { label: 'Pick the task', scope: Q, run: () => selected.value !== null && pick(selected.value, false, orderIds()) },
    X: { label: 'Pick every task shown', scope: Q, run: pickShown },
    Escape: {
      label: 'Clear the picks, close the peek',
      scope: Q,
      run: () => {
        if (picked.value.length) clearPicked();
        else if (peek.value) peek.value = false;
      },
    },
    Enter: { label: 'Open the task', scope: Q, run: () => selected.value !== null && emit('open', selected.value) },
    a: {
      label: 'Approve',
      scope: Q,
      run: () => {
        const t = selectedTask();
        if (t && personEvents(t).includes('approve')) emit('act', 'approve', t.id);
      },
    },
    r: {
      label: 'Retry',
      scope: Q,
      run: () => {
        const t = selectedTask();
        if (t && quickRetry(t)) emit('act', 'retry', t.id);
      },
    },
    m: {
      label: 'Merge',
      scope: Q,
      run: () => {
        const t = selectedTask();
        if (t && canStartMerge(t)) startMerge(t.id);
      },
    },
    v: { label: 'Next view', scope: Q, run: nextMode },
    c: { label: 'New task', scope: Q, run: () => openPanel('new') },
    ...edits.keys,
  });

  return {
    display,
    filters,
    shown,
    groups,
    toggleGroup,
    orderIds,
    pickChain,
    peek,
    act,
    edits,
    merging,
    startMerge,
    onMerged,
    onRequested,
    picked,
    pick,
    bar: bulk.bar,
    bulkMerging: bulk.bulkMerging,
    bulkPending: bulk.pending,
    togglePicks: bulk.toggleGroup,
    clearPicked,
    bulkAct: bulk.bulkAct,
    bulkEdit: bulk.bulkEdit,
    onBulkMerged: bulk.onBulkMerged,
    mergeAll: bulk.mergeAll,
  };
}
