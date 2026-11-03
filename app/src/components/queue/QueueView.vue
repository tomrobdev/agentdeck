<script setup lang="ts">
import { ref } from 'vue';
import { type TaskSummary, api, syncLine } from '../../api';
import { useActions } from '../../composables/useActions';
import { useBulkPick } from '../../composables/useBulkPick';
import { useHotkeys } from '../../composables/useHotkeys';
import { useMergeConfirm } from '../../composables/useMergeConfirm';
import { useQueueDisplay } from '../../composables/useQueueDisplay';
import { type BoardMove, type PersonEvent, canStartMerge, emptyFilters, hasFilters, personEvents, quickRetry } from '../../lib/taskView';
import BulkMergeDialog from '../task/BulkMergeDialog.vue';
import MergeDialog from '../task/MergeDialog.vue';
import SegmentedControl from '../ui/SegmentedControl.vue';
import BoardView from './BoardView.vue';
import BulkBar from './BulkBar.vue';
import DisplayMenu from './DisplayMenu.vue';
import FilterBar from './FilterBar.vue';
import GraphView from './GraphView.vue';
import ListView from './ListView.vue';
import PeekPane from './PeekPane.vue';
import QueueFooter from './QueueFooter.vue';

const props = defineProps<{ tasks: TaskSummary[] }>();
const selected = defineModel<number | null>('selected', { required: true });
const emit = defineEmits<{ open: [id: number]; act: [kind: PersonEvent, id: number]; newTask: [] }>();

const { display, filters, shown, groups, order, toggleGroup, nextMode } = useQueueDisplay(() => props.tasks);
const {
  picked,
  bar,
  bulkMerging,
  pending: bulkPending,
  pick,
  clearPicked,
  bulkAct,
  onBulkMerged,
  mergeAll,
} = useBulkPick(() => props.tasks, order);

function step(by: number) {
  const list = order.value;
  if (!list.length) return;
  const i = list.findIndex((t) => t.id === selected.value);
  selected.value = list[Math.min(Math.max(i === -1 ? 0 : i + by, 0), list.length - 1)].id;
}

const { merging, startMerge, onMerged, onRequested } = useMergeConfirm(order, selected);
const { flash, run } = useActions();

// Space opens the selected task beside the list (list view only). The panel follows the selection; its width is remembered.
const peek = ref(false);

// A PR in review moves on from its row: Merge (or a drop on Done) opens the merge confirm, Sync brings the base into its
// branch. A sync that conflicts starts a resolve run, which takes minutes; the row shows the sync from the task's summary,
// whoever started it, until it ends.
async function sync(id: number) {
  if (props.tasks.find((t) => t.id === id)?.sync) return;
  let done = '';
  const ok = await run(async () => {
    const r = await api.sync(id);
    done = `#${id}: ${syncLine(r)}${r.push_error ? ` Could not push: ${r.push_error}` : ''}`;
  });
  if (ok) flash(done);
}
function act(kind: BoardMove | 'sync', id: number) {
  const task = props.tasks.find((t) => t.id === id);
  if (kind === 'merge') {
    if (task && canStartMerge(task)) startMerge(id);
  } else if (kind === 'sync') sync(id);
  else emit('act', kind, id);
}

const selectedTask = () => props.tasks.find((x) => x.id === selected.value);
useHotkeys({
  j: () => step(1),
  ArrowDown: () => step(1),
  k: () => step(-1),
  ArrowUp: () => step(-1),
  ' ': () => {
    if (display.value.mode !== 'list') return;
    if (selected.value === null && order.value.length) selected.value = order.value[0].id;
    peek.value = !peek.value;
  },
  x: () => display.value.mode === 'list' && selected.value !== null && pick(selected.value, false),
  Escape: () => {
    if (picked.value.length) clearPicked();
    else if (peek.value) peek.value = false;
  },
  Enter: () => selected.value !== null && emit('open', selected.value),
  a: () => {
    const t = selectedTask();
    if (t && personEvents(t).includes('approve')) emit('act', 'approve', t.id);
  },
  r: () => {
    const t = selectedTask();
    if (t && quickRetry(t)) emit('act', 'retry', t.id);
  },
  m: () => {
    const t = selectedTask();
    if (t && canStartMerge(t)) startMerge(t.id);
  },
  v: nextMode,
  c: () => emit('newTask'),
});
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col bg-panel">
    <div class="flex items-center gap-2.5 border-b border-border px-4 py-2 max-sm:flex-wrap">
      <SegmentedControl
        label="View"
        :options="[
          { value: 'list', label: '≡ List', title: 'List (v)' },
          { value: 'board', label: '▦ Board', title: 'Board (v)' },
          { value: 'graph', label: '⑂ Graph', title: 'Graph (v)' },
        ]"
        :model-value="display.mode"
        @update:model-value="(mode) => (display = { ...display, mode })"
      />
      <FilterBar v-model="filters" :tasks="tasks" />
      <DisplayMenu v-model="display" />
    </div>

    <div class="flex min-h-0 flex-1">
      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <p v-if="!shown.length && hasFilters(filters)" class="text-muted px-4 py-6">
          Nothing matches these filters.
          <button class="btn-ghost text-accent underline" @click="filters = emptyFilters()">Clear filters</button>
        </p>
        <ListView
          v-else-if="display.mode === 'list'"
          :groups="groups"
          :group-by="display.groupBy"
          :collapsed="display.collapsed"
          :selected="selected"
          :picked="picked"
          :show="display.show"
          :show-empty="display.showEmpty"
          @toggle="toggleGroup"
          @pick="pick"
          @select="selected = $event"
          @open="emit('open', $event)"
          @act="act"
          @merge="startMerge"
          @merge-all="mergeAll"
        />
        <GraphView
          v-else-if="display.mode === 'graph'"
          :all="tasks"
          :shown="shown"
          :selected="selected"
          :show-finished="!!display.showFinished"
          @select="selected = $event"
          @open="emit('open', $event)"
        />
        <BoardView
          v-else
          :groups="groups"
          :selected="selected"
          :show="display.show"
          @select="selected = $event"
          @open="emit('open', $event)"
          @move="act"
          @merge="startMerge"
          @merge-all="mergeAll"
        />
        <BulkBar
          v-if="picked.length && display.mode === 'list'"
          :count="picked.length"
          :actions="bar"
          :busy="bulkPending"
          @act="bulkAct"
          @clear="clearPicked"
        />
      </div>
      <PeekPane
        v-if="peek && display.mode === 'list' && selected !== null"
        :id="selected"
        @open="emit('open', selected!)"
        @close="peek = false"
      />
    </div>
    <QueueFooter :shown="shown.length" :total="tasks.length" />
    <BulkMergeDialog v-if="bulkMerging" :tasks="bulkMerging" @close="bulkMerging = null" @done="onBulkMerged" />
    <MergeDialog v-if="merging" :task-id="merging.id" @close="merging = null" @merged="onMerged" @requested="onRequested" />
  </section>
</template>
