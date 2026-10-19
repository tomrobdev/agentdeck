<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { TaskSummary } from '../../api';
import { useHotkeys } from '../../hotkeys';
import {
  type BoardMove,
  type Filters,
  applyFilters,
  canApprove,
  emptyFilters,
  groupTasks,
  hasFilters,
  loadSetting,
  quickRetry,
  saveSetting,
} from '../../taskView';
import BoardView from './BoardView.vue';
import DisplayMenu, { type Display } from './DisplayMenu.vue';
import FilterBar from './FilterBar.vue';
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
    collapsed: ['cancelled'],
  }),
);
// The search box isn't remembered; the rest of the filters are.
const saved = loadSetting<Omit<Filters, 'search'>>('filters', { states: [], repos: [], source: null });
const filters = ref<Filters>({ ...emptyFilters(), ...saved, search: '' });
watch(display, (d) => saveSetting('display', d), { deep: true });
watch(filters, ({ search: _, ...f }) => saveSetting('filters', f), { deep: true });

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
  display.value.mode === 'board'
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

const selectedTask = () => props.tasks.find((x) => x.id === selected.value);
useHotkeys({
  j: () => step(1),
  ArrowDown: () => step(1),
  k: () => step(-1),
  ArrowUp: () => step(-1),
  Enter: () => selected.value !== null && emit('open', selected.value),
  a: () => {
    const t = selectedTask();
    if (t && canApprove(t)) emit('act', 'approve', t.id);
  },
  r: () => {
    const t = selectedTask();
    if (t && quickRetry(t)) emit('act', 'retry', t.id);
  },
  v: () => (display.value = { ...display.value, mode: display.value.mode === 'list' ? 'board' : 'list' }),
  c: () => emit('newTask'),
});
</script>

<template>
  <section class="queue">
    <div class="toolbar">
      <div class="seg" role="tablist">
        <button :class="{ on: display.mode === 'list' }" role="tab" title="List (v)" @click="display = { ...display, mode: 'list' }">
          ≡ List
        </button>
        <button :class="{ on: display.mode === 'board' }" role="tab" title="Board (v)" @click="display = { ...display, mode: 'board' }">
          ▦ Board
        </button>
      </div>
      <FilterBar v-model="filters" :tasks="tasks" />
      <DisplayMenu v-model="display" />
    </div>

    <p v-if="!shown.length && hasFilters(filters)" class="empty muted">
      Nothing matches these filters. <button class="link" @click="filters = emptyFilters()">Clear filters</button>
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
    />
    <BoardView
      v-else
      :groups="groups"
      :selected="selected"
      :show="display.show"
      @select="selected = $event"
      @open="emit('open', $event)"
      @move="(kind, id) => emit('act', kind, id)"
    />
    <footer class="foot muted">
      <span
        >{{ shown.length }}<template v-if="shown.length !== tasks.length"> of {{ tasks.length }}</template> tasks</span
      >
      <span class="keys"
        ><kbd>j</kbd><kbd>k</kbd> move · <kbd>↵</kbd> open · <kbd>a</kbd> approve · <kbd>r</kbd> retry · <kbd>v</kbd> board ·
        <kbd>c</kbd> new · <kbd>/</kbd> search</span
      >
    </footer>
  </section>
</template>

<style scoped>
.queue {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  background: var(--panel);
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
}
.empty {
  padding: 24px 16px;
}
.link {
  border: none;
  background: none;
  padding: 0;
  color: var(--accent);
  text-decoration: underline;
}
.foot {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 16px;
  font-size: 12px;
  border-top: 1px solid var(--border);
}
kbd {
  font:
    11px ui-monospace,
    Menlo,
    monospace;
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 4px;
  padding: 0 4px;
  margin: 0 1px;
}
@media (max-width: 720px) {
  .toolbar {
    flex-wrap: wrap;
  }
  .keys {
    display: none;
  }
}
</style>
