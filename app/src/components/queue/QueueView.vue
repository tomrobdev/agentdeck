<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { MergeResult, TaskSummary } from '../../api';
import { useActions } from '../../composables/useActions';
import MergeDialog from '../task/MergeDialog.vue';
import { useHotkeys } from '../../composables/useHotkeys';
import { go, route } from '../../router';
import {
  type BoardMove,
  type Filters,
  applyFilters,
  canReview,
  emptyFilters,
  groupTasks,
  hasFilters,
  personEvents,
  quickRetry,
} from '../../lib/taskView';
import { loadSetting, saveSetting } from '../../lib/storage';
import BoardView from './BoardView.vue';
import DisplayMenu, { type Display } from './DisplayMenu.vue';
import FilterBar from './FilterBar.vue';
import GraphView from './GraphView.vue';
import ListView from './ListView.vue';

const props = defineProps<{ tasks: TaskSummary[] }>();
const selected = defineModel<number | null>('selected', { required: true });
const emit = defineEmits<{ open: [id: number]; act: [kind: BoardMove, id: number]; newTask: [] }>();

const display = ref<Display>(
  loadSetting<Display>('display', {
    mode: 'list',
    groupBy: 'status',
    sort: 'attention',
    show: { repo: true, pr: true, time: true, reason: true },
    showEmpty: false,
    collapsed: ['cancelled', 'done'],
  }),
);
// Merged is part of Done now, which holds the finished history it did: collapse Done once, then leave it to the user.
if (loadSetting<boolean>('doneCollapsed', false) === false) {
  const collapsed = display.value.collapsed.filter((k) => k !== 'merged');
  display.value = { ...display.value, collapsed: collapsed.includes('done') ? collapsed : [...collapsed, 'done'] };
  saveSetting('doneCollapsed', true);
}
// The search box isn't remembered; the rest of the filters are.
const saved = loadSetting<Omit<Filters, 'search'>>('filters', { states: [], repos: [], source: null });
const filters = ref<Filters>({ ...emptyFilters(), ...saved, search: '' });
watch(display, (d) => saveSetting('display', d), { deep: true });
watch(filters, ({ search: _, ...f }) => saveSetting('filters', f), { deep: true });
// A link such as the header's "need you" opens the queue filtered to some states; the filter then stays the user's.
watch(
  () => route.current,
  (r) => {
    if (r.name !== 'queue' || !r.states) return;
    filters.value = { ...emptyFilters(), states: r.states };
    go({ name: 'queue' }, { replace: true });
  },
  { immediate: true },
);

const shown = computed(() => applyFilters(props.tasks, filters.value));
const groups = computed(() => {
  const board = display.value.mode === 'board';
  const all = groupTasks(shown.value, board ? 'status' : display.value.groupBy, display.value.sort);
  if (!board) return all;
  // The board reads left to right as the work flows: review sits just before done.
  const review = all.find((g) => g.key === 'review');
  if (!review) return all;
  const rest = all.filter((g) => g !== review);
  const done = rest.findIndex((g) => g.key === 'done');
  return [...rest.slice(0, done), review, ...rest.slice(done)];
});

/** The rows in screen order, skipping collapsed groups: what j and k walk through. */
const order = computed(() =>
  display.value.mode !== 'list'
    ? groups.value.flatMap((g) => g.tasks)
    : groups.value.filter((g) => display.value.groupBy === 'none' || !display.value.collapsed.includes(g.key)).flatMap((g) => g.tasks),
);

function toggleGroup(key: string) {
  const c = display.value.collapsed;
  display.value = { ...display.value, collapsed: c.includes(key) ? c.filter((k) => k !== key) : [...c, key] };
}

function step(by: number) {
  const list = order.value;
  if (!list.length) return;
  const i = list.findIndex((t) => t.id === selected.value);
  selected.value = list[Math.min(Math.max(i === -1 ? 0 : i + by, 0), list.length - 1)].id;
}

// The merge confirm, opened from a row's button or `m`. After a merge the selection moves to the next row.
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
  if (result.cleanup_error) flash(`Merged, but cleanup failed: ${result.cleanup_error}`);
}

const MODES: Display['mode'][] = ['list', 'board', 'graph'];
const selectedTask = () => props.tasks.find((x) => x.id === selected.value);
useHotkeys({
  j: () => step(1),
  ArrowDown: () => step(1),
  k: () => step(-1),
  ArrowUp: () => step(-1),
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
    if (t && canReview(t)) startMerge(t.id);
  },
  v: () => (display.value = { ...display.value, mode: MODES[(MODES.indexOf(display.value.mode) + 1) % MODES.length] }),
  c: () => emit('newTask'),
});
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col bg-panel">
    <div class="flex items-center gap-2.5 border-b border-border px-4 py-2 max-sm:flex-wrap">
      <div class="seg" role="tablist">
        <button :class="{ on: display.mode === 'list' }" role="tab" title="List (v)" @click="display = { ...display, mode: 'list' }">
          ≡ List
        </button>
        <button :class="{ on: display.mode === 'board' }" role="tab" title="Board (v)" @click="display = { ...display, mode: 'board' }">
          ▦ Board
        </button>
        <button :class="{ on: display.mode === 'graph' }" role="tab" title="Graph (v)" @click="display = { ...display, mode: 'graph' }">
          ⑂ Graph
        </button>
      </div>
      <FilterBar v-model="filters" :tasks="tasks" />
      <DisplayMenu v-model="display" />
    </div>

    <p v-if="!shown.length && hasFilters(filters)" class="muted px-4 py-6">
      Nothing matches these filters.
      <button class="btn-ghost text-accent underline" @click="filters = emptyFilters()">Clear filters</button>
    </p>
    <ListView
      v-else-if="display.mode === 'list'"
      :groups="groups"
      :group-by="display.groupBy"
      :collapsed="display.collapsed"
      :selected="selected"
      :show="display.show"
      :show-empty="display.showEmpty"
      @toggle="toggleGroup"
      @select="selected = $event"
      @open="emit('open', $event)"
      @act="(kind, id) => emit('act', kind, id)"
      @merge="startMerge"
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
      @move="(kind, id) => emit('act', kind, id)"
      @merge="startMerge"
    />
    <footer class="muted flex justify-between gap-3 border-t border-border px-4 py-[5px] text-sm">
      <span
        >{{ shown.length }}<template v-if="shown.length !== tasks.length"> of {{ tasks.length }}</template> tasks</span
      >
      <span class="max-sm:hidden"
        ><kbd>j</kbd><kbd>k</kbd> move · <kbd>↵</kbd> open · <kbd>a</kbd> approve · <kbd>r</kbd> retry · <kbd>m</kbd> merge ·<kbd>v</kbd>
        list/board/graph · <kbd>c</kbd> new · <kbd>/</kbd> search</span
      >
    </footer>
    <MergeDialog v-if="merging" :task-id="merging.id" @close="merging = null" @merged="onMerged" />
  </section>
</template>
