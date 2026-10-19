<script setup lang="ts">
import { nextTick, watch } from 'vue';
import { ago } from '../../api';
import { openExternal } from '../../native';
import { type Group, type GroupBy, canApprove, quickRetry, statusLabel } from '../../taskView';
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
  <div class="list" role="list">
    <template v-for="g in groups" :key="g.key">
      <section v-if="g.tasks.length || showEmpty" class="group">
        <button v-if="groupBy !== 'none'" class="ghead" :aria-expanded="!collapsed.includes(g.key)" @click="emit('toggle', g.key)">
          <span class="caret" :class="{ shut: collapsed.includes(g.key) }">▾</span>
          <span class="glabel">{{ g.label }}</span>
          <span class="gcount">{{ g.tasks.length }}</span>
        </button>
        <template v-if="!collapsed.includes(g.key)">
          <div
            v-for="t in g.tasks"
            :key="t.id"
            class="row"
            role="listitem"
            :class="[`s-${t.status}`, { sel: t.id === selected }]"
            :data-task-row="t.id"
            @click="emit('open', t.id)"
            @mouseenter="emit('select', t.id)"
          >
            <PriorityIcon :priority="t.priority" />
            <span class="id">#{{ t.id }}</span>
            <StatusIcon :task="t" />
            <span class="main">
              <span class="title">{{ t.title }}</span>
              <span v-if="show.reason && t.blocked_reason && (t.status === 'blocked' || t.status === 'failed')" class="reason">
                {{ t.blocked_reason }}
              </span>
              <span v-else-if="show.reason && t.waiting?.stuck" class="reason">Can't start: {{ t.waiting.stuck }}</span>
            </span>
            <span class="chips">
              <span v-if="t.waiting && !t.waiting.stuck" class="chip">waiting #{{ t.waiting.on }}</span>
              <span v-if="t.source === 'planner'" class="chip">planner</span>
              <span v-if="t.attempts > 1" class="chip">try {{ t.attempts }}</span>
              <span v-if="show.pr && t.pr_url" class="chip" :class="`pr-${t.pr_state ?? 'open'}`">PR {{ t.pr_state ?? 'open' }}</span>
              <span v-if="show.repo" class="chip repo">{{ t.repo }}</span>
            </span>
            <span class="actions" @click.stop>
              <button v-if="canApprove(t)" title="Approve (a)" @click="emit('act', 'approve', t.id)">Approve</button>
              <button v-if="quickRetry(t)" title="Retry (r)" @click="emit('act', 'retry', t.id)">Retry</button>
              <button v-if="t.pr_url" title="Open the pull request" @click="openExternal(t.pr_url)">PR ↗</button>
            </span>
            <span v-if="show.time" class="time" :title="`${statusLabel(t.status)} · updated ${t.updated_at} UTC`">{{
              ago(t.updated_at)
            }}</span>
          </div>
          <p v-if="!g.tasks.length" class="none muted">No tasks</p>
        </template>
      </section>
    </template>
  </div>
</template>

<style scoped>
.list {
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.ghead {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: none;
  border-radius: 0;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
  padding: 6px 16px;
  font-weight: 600;
  position: sticky;
  top: 0;
  z-index: 1;
}
.caret {
  font-size: 10px;
  color: var(--muted);
  transition: transform 0.12s;
}
.caret.shut {
  transform: rotate(-90deg);
}
.gcount {
  color: var(--muted);
  font-weight: 400;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 4px 16px;
  border-bottom: 1px solid var(--border);
  cursor: default;
}
.row.sel {
  background: color-mix(in srgb, var(--accent) 8%, var(--panel));
  box-shadow: inset 2px 0 0 var(--accent);
}
.id {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  width: 34px;
  flex: none;
  font-size: 12px;
}
.main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.reason {
  font-size: 12px;
  color: var(--blocked);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.s-failed .reason {
  color: var(--failed);
}
.chips {
  display: flex;
  gap: 4px;
  flex: none;
}
.chip {
  font-size: 11.5px;
  padding: 0 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--muted);
  white-space: nowrap;
  line-height: 18px;
}
.chip.pr-merged {
  color: #8250df;
  border-color: color-mix(in srgb, #8250df 45%, transparent);
}
.chip.pr-open {
  color: var(--done);
  border-color: color-mix(in srgb, var(--done) 45%, transparent);
}
.chip.repo {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.actions {
  display: none;
  gap: 4px;
  flex: none;
}
.actions button {
  padding: 1px 8px;
  font-size: 12px;
}
.row:hover .actions,
.row.sel .actions {
  display: flex;
}
.time {
  color: var(--muted);
  font-size: 12px;
  width: 52px;
  text-align: right;
  flex: none;
  font-variant-numeric: tabular-nums;
}
.none {
  padding: 8px 16px 8px 58px;
  margin: 0;
  font-size: 12px;
  border-bottom: 1px solid var(--border);
}
@media (max-width: 720px) {
  .chips .chip:not(.repo) {
    display: none;
  }
}
</style>
