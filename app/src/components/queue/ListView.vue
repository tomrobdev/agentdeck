<script setup lang="ts">
import { nextTick, watch } from 'vue';
import { ago } from '../../api';
import { openExternal } from '../../native';
import { type Group, type GroupBy, canApprove, quickRetry, statusLabel, unblocksOf } from '../../taskView';
import PriorityIcon from './PriorityIcon.vue';
import StatusIcon from './StatusIcon.vue';

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
  show: ShowProps;
  showEmpty: boolean;
}>();
const emit = defineEmits<{
  toggle: [key: string];
  select: [id: number];
  open: [id: number];
  act: [kind: 'approve' | 'retry', id: number];
}>();

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
        <button
          v-if="groupBy !== 'none'"
          class="sticky top-0 z-1 flex w-full items-center gap-2 rounded-none border-0 border-b bg-panel-2 px-4 py-1.5 font-semibold"
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
        <template v-if="!collapsed.includes(g.key)">
          <div
            v-for="t in g.tasks"
            :key="t.id"
            class="group flex min-h-9 cursor-default items-center gap-2.5 border-b border-border px-4 py-1"
            role="listitem"
            :class="[
              `s-${t.status}`,
              t.id === selected ? 'bg-[color-mix(in_srgb,var(--accent)_8%,var(--panel))] shadow-[inset_2px_0_0_var(--accent)]' : '',
            ]"
            :data-task-row="t.id"
            @click="emit('open', t.id)"
            @mouseenter="emit('select', t.id)"
          >
            <PriorityIcon :priority="t.priority" />
            <span class="w-[34px] flex-none text-sm text-muted tabular-nums">#{{ t.id }}</span>
            <StatusIcon :task="t" />
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="truncate font-medium">{{ t.title }}</span>
              <span
                v-if="show.reason && t.blocked_reason && (t.status === 'blocked' || t.status === 'failed')"
                class="truncate text-sm text-blocked group-[.s-failed]:text-failed"
              >
                {{ t.blocked_reason }}
              </span>
              <span v-else-if="show.reason && t.waiting?.stuck" class="truncate text-sm text-blocked group-[.s-failed]:text-failed"
                >Can't start: {{ t.waiting.stuck }}</span
              >
              <span
                v-else-if="show.reason && t.hold?.kind === 'repo-paused'"
                class="truncate text-sm text-blocked group-[.s-failed]:text-failed"
                >Can't start: {{ t.repo }} is paused</span
              >
            </span>
            <span class="flex flex-none gap-1 max-sm:[&>:not([data-repo])]:hidden">
              <span v-if="t.waiting && !t.waiting.stuck" class="chip">waiting #{{ t.waiting.on }}</span>
              <span v-if="unblocksOf(t).length" class="chip chip-accent" title="Merging this PR releases them">
                unblocks
                {{
                  unblocksOf(t)
                    .map((id) => `#${id}`)
                    .join(' ')
                }}
              </span>
              <span v-if="t.plan_unfinished" class="chip" title="The run left linked plan steps unfinished">steps unfinished</span>
              <span v-if="t.source === 'planner'" class="chip">planner</span>
              <span v-if="t.attempts > 1" class="chip">try {{ t.attempts }}</span>
              <span
                v-if="show.pr && t.pr_url"
                class="chip"
                :class="t.pr_state === 'merged' ? 'chip-merged' : (t.pr_state ?? 'open') === 'open' ? 'chip-done' : ''"
                >PR {{ t.pr_state ?? 'open' }}</span
              >
              <span v-if="show.repo" data-repo class="chip max-w-[120px] truncate">{{ t.repo }}</span>
            </span>
            <span class="flex-none gap-1" :class="t.id === selected ? 'flex' : 'hidden group-hover:flex'" @click.stop>
              <button v-if="canApprove(t)" class="btn-mini" title="Approve (a)" @click="emit('act', 'approve', t.id)">Approve</button>
              <button v-if="quickRetry(t)" class="btn-mini" title="Retry (r)" @click="emit('act', 'retry', t.id)">Retry</button>
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
  </div>
</template>
