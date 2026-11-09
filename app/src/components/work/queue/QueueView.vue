<script setup lang="ts">
import type { TaskSummary } from '../../../api/types';
import { useQueueView } from '../../../composables/work/queue/useQueueView';
import type { PersonEvent } from '../../../../../daemon/src/domain/work/index.ts';
import { emptyFilters, hasFilters } from '../../../lib/work/task-view';
import BulkMergeDialog from '../../landing/BulkMergeDialog.vue';
import EditKeyDialog from '../task/EditKeyDialog.vue';
import MergeDialog from '../../landing/MergeDialog.vue';
import SegmentedControl from '../../ui/form/SegmentedControl.vue';
import BoardView from './BoardView.vue';
import BulkBar from './BulkBar.vue';
import DisplayMenu from './DisplayMenu.vue';
import FilterBar from './FilterBar.vue';
import GraphView from './GraphView.vue';
import ListView from './ListView.vue';
import PeekPane from './PeekPane.vue';
import QueueFooter from './QueueFooter.vue';

// The queue as a list, a board or a graph, with its filters, picks and keys. The state is in useQueueView.
const props = defineProps<{ tasks: TaskSummary[] }>();
const selected = defineModel<number | null>('selected', { required: true });
const emit = defineEmits<{ open: [id: number]; act: [kind: PersonEvent, id: number] }>();

const {
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
  bar,
  bulkMerging,
  bulkPending,
  togglePicks,
  clearPicked,
  bulkAct,
  bulkEdit,
  onBulkMerged,
  mergeAll,
} = useQueueView(() => props.tasks, selected, emit);
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
          @pick="(id, range) => pick(id, range, orderIds())"
          @pick-group="togglePicks"
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
          :picked="picked"
          @select="selected = $event"
          @pick-chain="pickChain"
          @open="emit('open', $event)"
        />
        <BoardView
          v-else
          :groups="groups"
          :selected="selected"
          :picked="picked"
          :show="display.show"
          @select="selected = $event"
          @pick="(id, range, column) => pick(id, range, column)"
          @open="emit('open', $event)"
          @move="act"
          @merge="startMerge"
          @merge-all="mergeAll"
        />
        <BulkBar
          v-if="picked.length"
          :count="picked.length"
          :actions="bar"
          :busy="bulkPending"
          :others="tasks.filter((t) => !picked.includes(t.id))"
          @act="bulkAct"
          @edit="bulkEdit"
          @clear="clearPicked"
        />
      </div>
      <PeekPane
        v-if="peek && display.mode === 'list' && selected !== null"
        :id="selected"
        @open="emit('open', selected!)"
        @close="peek = false"
        @act="act"
        @merge="startMerge"
        @peek="selected = $event"
      />
    </div>
    <QueueFooter :shown="shown.length" :total="tasks.length" />
    <EditKeyDialog v-if="edits.dialog.value" :kind="edits.dialog.value" :keys="edits" />
    <BulkMergeDialog v-if="bulkMerging" :tasks="bulkMerging" @close="bulkMerging = null" @done="onBulkMerged" />
    <MergeDialog v-if="merging" :task-id="merging.id" @close="merging = null" @merged="onMerged" @requested="onRequested" />
  </section>
</template>
