<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ago } from '../../api';
import { mergeAllIds } from '../../lib/bulk';
import { openExternal } from '../../platform/native';
import MergeButtons from './MergeButtons.vue';
import RowMenu from './RowMenu.vue';
import { type BoardMove, type Group, type GroupBy, personEvents, quickRetry, statusLabel } from '../../lib/taskView';
import Checkbox from '../ui/Checkbox.vue';
import PriorityIcon from '../ui/PriorityIcon.vue';
import StatusIcon from '../ui/StatusIcon.vue';
import TaskBadges from '../ui/TaskBadges.vue';
import TaskStatusLine from '../ui/TaskStatusLine.vue';

export interface ShowProps {
  repo: boolean;
  pr: boolean;
  time: boolean;
  reason: boolean;
}

const props = defineProps<{
  groups: Group[];
  groupBy: GroupBy;
  collapsed: string[];
  selected: number | null;
  /** The tasks picked for a bulk action (`x`, shift-click). */
  picked?: number[];
  show: ShowProps;
  showEmpty: boolean;
}>();
const emit = defineEmits<{
  toggle: [key: string];
  select: [id: number];
  pick: [id: number, range: boolean];
  open: [id: number];
  act: [kind: BoardMove | 'sync', id: number];
  merge: [id: number];
  mergeAll: [ids: number[]];
}>();

// The row menu: right-click on a row, or the context-menu key / ⇧F10 on the selected one.
const menu = ref<{ id: number; x: number; y: number } | null>(null);
const menuTask = computed(() => props.groups.flatMap((g) => g.tasks).find((t) => t.id === menu.value?.id));
function openMenu(id: number, x: number, y: number) {
  emit('select', id);
  menu.value = { id, x, y };
}
function onKey(e: KeyboardEvent) {
  if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
  if (props.selected === null || e.defaultPrevented || document.querySelector('[role="dialog"]')) return;
  if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable]')) return;
  const row = document.querySelector(`[data-task-row="${props.selected}"]`);
  if (!row) return;
  e.preventDefault();
  const r = row.getBoundingClientRect();
  openMenu(props.selected, r.left + 48, r.bottom);
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

// Keep the selected row in view when the keyboard moves it.
watch(
  () => props.selected,
  async (id) => {
    await nextTick();
    document.querySelector(`[data-task-row="${id}"]`)?.scrollIntoView({ block: 'nearest' });
  },
);
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto" role="list">
    <template v-for="g in groups" :key="g.key">
      <section v-if="g.tasks.length || showEmpty">
        <div v-if="groupBy !== 'none'" class="sticky top-0 z-1 flex items-center border-b border-border bg-panel-2 pr-4">
          <button
            class="flex min-w-0 flex-1 items-center gap-2 rounded-none border-0 bg-transparent px-4 py-1.5 font-semibold"
            :aria-expanded="!collapsed.includes(g.key)"
            @click="emit('toggle', g.key)"
          >
            <span
              class="text-2xs text-muted transition-transform duration-[120ms] ease-[ease]"
              :class="collapsed.includes(g.key) ? '-rotate-90' : ''"
              >▾</span
            >
            <span>{{ g.label }}</span>
            <span class="font-normal text-muted">{{ g.tasks.length }}</span>
          </button>
          <button
            v-if="mergeAllIds(g).length"
            class="btn-mini flex-none"
            title="Merge every pull request in this group, each with its task's method"
            @click="emit('mergeAll', mergeAllIds(g))"
          >
            Merge all
          </button>
        </div>
        <template v-if="!collapsed.includes(g.key)">
          <div
            v-for="t in g.tasks"
            :key="t.id"
            class="group flex min-h-9 cursor-default items-center gap-2.5 border-b border-border px-4 py-1"
            role="listitem"
            :class="[
              `s-${t.status}`,
              t.id === selected ? 'bg-[color-mix(in_srgb,var(--accent)_8%,var(--panel))] shadow-[inset_2px_0_0_var(--accent)]' : '',
              picked?.includes(t.id) ? 'bg-[color-mix(in_srgb,var(--accent)_16%,var(--panel))]' : '',
            ]"
            :data-task-row="t.id"
            @click="$event.shiftKey ? emit('pick', t.id, true) : emit('open', t.id)"
            @mousedown="$event.shiftKey && $event.preventDefault()"
            @mouseenter="emit('select', t.id)"
            @contextmenu.prevent="openMenu(t.id, $event.clientX, $event.clientY)"
          >
            <Checkbox
              v-if="picked?.length"
              :label="`Pick #${t.id}`"
              :model-value="picked.includes(t.id)"
              @click.stop
              @update:model-value="emit('pick', t.id, false)"
            />
            <PriorityIcon :priority="t.priority" />
            <span class="w-[34px] flex-none font-mono text-sm text-muted tabular-nums">#{{ t.id }}</span>
            <StatusIcon :task="t" />
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="truncate font-medium">{{ t.title }}</span>
              <TaskStatusLine :task="t" :hide="show.reason ? [] : ['stopped', 'cant_start']" />
            </span>
            <TaskBadges :task="t" :repo="show.repo" :pr="show.pr" nowrap class="max-w-[45%] flex-none max-sm:hidden" />
            <span class="flex-none gap-1" :class="t.id === selected || t.sync ? 'flex' : 'hidden group-hover:flex'" @click.stop>
              <button v-if="personEvents(t).includes('approve')" class="btn-mini" title="Approve (a)" @click="emit('act', 'approve', t.id)">
                Approve
              </button>
              <button v-if="quickRetry(t)" class="btn-mini" title="Retry (r)" @click="emit('act', 'retry', t.id)">Retry</button>
              <MergeButtons :task="t" sync @sync="emit('act', 'sync', $event)" @merge="emit('merge', $event)" />
              <button v-if="t.pr_url" class="btn-mini" title="Open the pull request" @click="openExternal(t.pr_url)">PR ↗</button>
            </span>
            <span
              v-if="show.time"
              class="w-[52px] flex-none text-right text-sm text-muted tabular-nums"
              :title="`${statusLabel(t.status)} · updated ${t.updated_at} UTC`"
              >{{ ago(t.updated_at) }}</span
            >
          </div>
          <p v-if="!g.tasks.length" class="m-0 border-b border-border py-2 pr-4 pl-[58px] text-sm text-muted">No tasks</p>
        </template>
      </section>
    </template>
    <RowMenu
      v-if="menu && menuTask"
      :task="menuTask"
      :x="menu.x"
      :y="menu.y"
      @close="menu = null"
      @open="emit('open', $event)"
      @act="(kind, id) => emit('act', kind, id)"
      @merge="emit('merge', $event)"
    />
  </div>
</template>
