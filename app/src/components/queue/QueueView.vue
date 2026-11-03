<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { type MergeResult, type TaskSummary, api, syncLine } from '../../api';
import { useActions } from '../../composables/useActions';
import { type BulkAction, bulkActions, idRange } from '../../lib/bulk';
import BulkMergeDialog from '../task/BulkMergeDialog.vue';
import MergeDialog from '../task/MergeDialog.vue';
import BulkBar from './BulkBar.vue';
import { useHotkeys } from '../../composables/useHotkeys';
import { requestedView } from '../../composables/useView';
import { go, route } from '../../router';
import {
  type BoardMove,
  type Filters,
  type PersonEvent,
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
import SegmentedControl from '../ui/SegmentedControl.vue';
import TaskPeek from './TaskPeek.vue';

const props = defineProps<{ tasks: TaskSummary[] }>();
const selected = defineModel<number | null>('selected', { required: true });
const emit = defineEmits<{ open: [id: number]; act: [kind: PersonEvent, id: number]; newTask: [] }>();

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
// The command palette asks for a view; apply it when it arrives (also when this mounts after the palette sent it).
watch(
  requestedView,
  (mode) => {
    if (!mode) return;
    display.value = { ...display.value, mode };
    requestedView.value = null;
  },
  { immediate: true },
);
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
const { refresh, flash, run, busy } = useActions();
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
// A requested merge leaves the PR in review until the daemon merges it, so the selection stays.
function onRequested() {
  merging.value = null;
}

// Space opens the selected task beside the list (list view only). The panel follows the selection; its width is remembered.
const peek = ref(false);
const peeking = computed(() => peek.value && display.value.mode === 'list' && selected.value !== null);
const PEEK_MIN = 320;
const peekWidth = ref(Math.max(PEEK_MIN, loadSetting<number>('peekWidth', 520)));
function startResize(down: PointerEvent) {
  const startX = down.clientX;
  const startW = peekWidth.value;
  const move = (e: PointerEvent) => {
    peekWidth.value = Math.round(Math.min(Math.max(startW + startX - e.clientX, PEEK_MIN), window.innerWidth - 320));
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    saveSetting('peekWidth', peekWidth.value);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

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
  if ((kind === 'merge' || kind === 'sync') && task?.sync) return;
  if (kind === 'merge' && task?.merge_request) return;
  if (kind === 'merge') startMerge(id);
  else if (kind === 'sync') sync(id);
  else emit('act', kind, id);
}
/** "Merge all" on the Review group: the bulk merge confirm, for every PR in review that isn't syncing. */
function mergeAll(ids: number[]) {
  bulkMerging.value = props.tasks.filter((t) => ids.includes(t.id) && !t.sync && !t.merge_request);
}

// Bulk selection, in the list only: `x` or shift-click picks, and the bar offers what every picked task allows.
const picked = ref<number[]>([]);
const anchor = ref<number | null>(null);
const pickedTasks = computed(() => props.tasks.filter((t) => picked.value.includes(t.id)));
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
  const ids = new Set(o.map((t) => t.id));
  if (picked.value.some((id) => !ids.has(id))) picked.value = picked.value.filter((id) => ids.has(id));
});
const BULK_CALLS = { approve: api.approve, reject: api.reject, retry: (id: number) => api.retry(id), cancel: api.cancel };
async function bulkAct(action: BulkAction) {
  if (action === 'merge') {
    bulkMerging.value = pickedTasks.value;
    return;
  }
  const tasks = pickedTasks.value;
  const ok = await run(async () => {
    for (const t of tasks) {
      try {
        await BULK_CALLS[action](t.id);
      } catch (e) {
        throw new Error(`#${t.id}: ${(e as Error).message}`);
      }
    }
  });
  if (ok) clearPicked();
}
function onBulkMerged(merged: number[]) {
  bulkMerging.value = null;
  picked.value = picked.value.filter((id) => !merged.includes(id));
}

const MODES: Display['mode'][] = ['list', 'board', 'graph'];
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
    if (t && canReview(t) && !t.sync && !t.merge_request) startMerge(t.id);
  },
  v: () => (display.value = { ...display.value, mode: MODES[(MODES.indexOf(display.value.mode) + 1) % MODES.length] }),
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
          :busy="busy"
          @act="bulkAct"
          @clear="clearPicked"
        />
      </div>
      <template v-if="peeking">
        <div
          class="w-1 flex-none cursor-col-resize bg-border hover:bg-accent"
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize"
          @pointerdown="startResize"
        />
        <div class="flex min-h-0 flex-none flex-col border-l border-border" :style="{ width: `${peekWidth}px` }">
          <TaskPeek :id="selected!" @open="emit('open', selected!)" @close="peek = false" />
        </div>
      </template>
    </div>
    <footer class="muted flex justify-between gap-3 border-t border-border px-4 py-[5px] text-sm">
      <span
        >{{ shown.length }}<template v-if="shown.length !== tasks.length"> of {{ tasks.length }}</template> tasks</span
      >
      <span class="max-sm:hidden"
        ><kbd>j</kbd><kbd>k</kbd> move · <kbd>␣</kbd> peek · <kbd>↵</kbd> open · <kbd>a</kbd> approve · <kbd>r</kbd> retry ·
        <kbd>m</kbd> merge ·<kbd>v</kbd> list/board/graph · <kbd>x</kbd> select · <kbd>c</kbd> new · <kbd>/</kbd> search ·
        <kbd>⌘K</kbd> commands</span
      >
    </footer>
    <BulkMergeDialog v-if="bulkMerging" :tasks="bulkMerging" @close="bulkMerging = null" @done="onBulkMerged" />
    <MergeDialog v-if="merging" :task-id="merging.id" @close="merging = null" @merged="onMerged" @requested="onRequested" />
  </section>
</template>
