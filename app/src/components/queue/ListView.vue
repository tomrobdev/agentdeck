<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ago, describeLive, describeSync } from '../../api';
import { openExternal } from '../../platform/native';
import RowMenu from './RowMenu.vue';
import {
  type BoardMove,
  type Group,
  type GroupBy,
  canReview,
  personEvents,
  quickRetry,
  readNeeds,
  statusLabel,
  unblocksOf,
  waitsOnText,
} from '../../lib/taskView';
import AutoMergeMark from '../ui/AutoMergeMark.vue';
import PriorityIcon from '../ui/PriorityIcon.vue';
import StatusIcon from '../ui/StatusIcon.vue';

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

/** The PRs a group's "Merge all" would merge: only Review has any, less the ones syncing. */
const mergeable = (g: Group) => (g.key === 'review' ? g.tasks.filter((t) => canReview(t) && !t.sync).map((t) => t.id) : []);

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
            v-if="mergeable(g).length"
            class="btn-mini flex-none"
            title="Merge every pull request in this group, each with its task's method"
            @click="emit('mergeAll', mergeable(g))"
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
            <span
              v-if="picked?.length"
              class="w-3 flex-none text-accent"
              :aria-label="picked.includes(t.id) ? 'Selected' : undefined"
              @click.stop="emit('pick', t.id, false)"
              >{{ picked.includes(t.id) ? '☑' : '☐' }}</span
            >
            <PriorityIcon :priority="t.priority" />
            <span class="w-[34px] flex-none font-mono text-sm text-muted tabular-nums">#{{ t.id }}</span>
            <StatusIcon :task="t" />
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="truncate font-medium">{{ t.title }}</span>
              <span
                v-if="show.reason && t.stop_reason && (t.status === 'blocked' || t.status === 'failed')"
                class="truncate text-sm text-blocked group-[.s-failed]:text-failed"
              >
                {{ t.stop_reason }}
              </span>
              <span v-else-if="t.live" class="truncate text-sm text-muted tabular-nums" data-live>{{ describeLive(t.live) }}</span>
              <span v-else-if="t.sync" class="truncate text-sm text-accent tabular-nums" data-sync>{{ describeSync(t.sync) }}</span>
              <span v-else-if="show.reason && t.waiting?.stuck" class="truncate text-sm text-blocked group-[.s-failed]:text-failed"
                >Can't start: {{ t.waiting.stuck }}</span
              >
              <span
                v-else-if="show.reason && t.wait?.kind === 'repo-paused'"
                class="truncate text-sm text-blocked group-[.s-failed]:text-failed"
                >Can't start: {{ t.repo }} is paused</span
              >
            </span>
            <span class="flex flex-none gap-1 max-sm:[&>:not([data-repo])]:hidden">
              <span v-if="waitsOnText(t)" class="chip">{{ waitsOnText(t) }}</span>
              <span v-if="unblocksOf(t).length" class="chip chip-accent" title="Merging this PR releases them">
                unblocks
                {{
                  unblocksOf(t)
                    .map((id) => `#${id}`)
                    .join(' ')
                }}
              </span>
              <span v-if="readNeeds(t)" class="chip chip-blocked" title="The worker said what it needs: open the task">needs</span>
              <span v-if="t.plan_unfinished" class="chip" title="The run left linked plan steps unfinished">steps unfinished</span>
              <span v-if="t.source === 'planner'" class="chip">planner</span>
              <span v-if="t.attempts > 1" class="chip">try {{ t.attempts }}</span>
              <span
                v-if="show.pr && t.pr_url"
                class="chip"
                :class="t.pr_state === 'merged' ? 'chip-merged' : (t.pr_state ?? 'open') === 'open' ? 'chip-done' : ''"
                >PR {{ t.pr_state ?? 'open' }}</span
              >
              <AutoMergeMark :view="t.auto_merge_view" />
              <span v-if="show.repo" data-repo class="chip max-w-[120px] truncate">{{ t.repo }}</span>
            </span>
            <span class="flex-none gap-1" :class="t.id === selected || t.sync ? 'flex' : 'hidden group-hover:flex'" @click.stop>
              <button v-if="personEvents(t).includes('approve')" class="btn-mini" title="Approve (a)" @click="emit('act', 'approve', t.id)">
                Approve
              </button>
              <button v-if="quickRetry(t)" class="btn-mini" title="Retry (r)" @click="emit('act', 'retry', t.id)">Retry</button>
              <button v-if="t.sync" class="btn-mini" disabled>Syncing…</button>
              <template v-else-if="canReview(t)">
                <button
                  class="btn-mini"
                  title="Sync the branch with the base branch; a conflict starts a claude run"
                  @click="emit('act', 'sync', t.id)"
                >
                  Sync
                </button>
                <button class="btn-mini" title="Merge (m)" @click="emit('merge', t.id)">Merge</button>
              </template>
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
