<script setup lang="ts">
import { computed, ref } from 'vue';
import { type TaskSummary, type TaskStatus, ago } from '../api';

const props = defineProps<{ tasks: TaskSummary[]; selected: number | null }>();
defineEmits<{ select: [id: number] }>();

const FILTERS: { key: string; label: string; match: TaskStatus[] | null }[] = [
  { key: 'active', label: 'Active', match: ['running', 'cancel_requested', 'queued'] },
  { key: 'review', label: 'Needs you', match: ['proposed', 'blocked', 'failed'] },
  { key: 'done', label: 'Done', match: ['done'] },
  { key: 'all', label: 'All', match: null },
];
const filter = ref('all');

const ORDER: Record<TaskStatus, number> = {
  running: 0,
  cancel_requested: 0,
  proposed: 1,
  blocked: 2,
  failed: 3,
  queued: 4,
  done: 5,
  cancelled: 6,
};

const counts = computed(() =>
  Object.fromEntries(
    FILTERS.map((f) => [f.key, f.match ? props.tasks.filter((t) => f.match!.includes(t.status)).length : props.tasks.length]),
  ),
);

const shown = computed(() => {
  const f = FILTERS.find((x) => x.key === filter.value)!;
  return props.tasks
    .filter((t) => !f.match || f.match.includes(t.status))
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.priority - a.priority || b.id - a.id);
});

const label = (s: TaskStatus) => (s === 'cancel_requested' ? 'stopping' : s);

const byId = computed(() => new Map(props.tasks.map((t) => [t.id, t])));

/** The task this one is queued behind: its dependency isn't done yet, or is done with a PR that isn't merged. */
function waitingOn(t: TaskSummary): number | null {
  if (t.status !== 'queued' || t.after_task === null) return null;
  const dep = byId.value.get(t.after_task);
  if (!dep) return null; // older than the loaded page, so almost certainly finished
  return dep.status === 'done' && (dep.pr_url === null || dep.pr_state === 'merged') ? null : t.after_task;
}
</script>

<template>
  <aside class="list">
    <nav class="filters">
      <button v-for="f in FILTERS" :key="f.key" :class="{ on: filter === f.key }" @click="filter = f.key">
        {{ f.label }} <span class="n">{{ counts[f.key] }}</span>
      </button>
    </nav>
    <div class="items">
      <p v-if="!shown.length" class="empty muted">Nothing here.</p>
      <button
        v-for="t in shown"
        :key="t.id"
        class="item"
        :class="[`s-${t.status}`, { sel: t.id === selected }]"
        @click="$emit('select', t.id)"
      >
        <span class="dot" />
        <span class="main">
          <span class="title">{{ t.title }}</span>
          <span class="meta muted">
            #{{ t.id }} · {{ t.repo }} · {{ label(t.status) }}<template v-if="t.source === 'planner'"> · planner</template
            ><template v-if="waitingOn(t)"> · waiting on #{{ waitingOn(t) }}</template
            ><template v-if="t.pr_url"> · PR {{ t.pr_state ?? 'open' }}</template
            ><template v-if="t.attempts > 1"> · try {{ t.attempts }}</template> ·
            {{ ago(t.updated_at) }}
          </span>
          <span v-if="t.blocked_reason && (t.status === 'blocked' || t.status === 'failed')" class="reason">{{ t.blocked_reason }}</span>
        </span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.list {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--panel);
  min-height: 0;
}
.filters {
  display: flex;
  gap: 4px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.filters button {
  border: none;
  background: none;
  padding: 3px 8px;
  color: var(--muted);
}
.filters button.on {
  background: var(--panel-2);
  color: var(--text);
}
.n {
  font-size: 11px;
  opacity: 0.7;
  margin-left: 2px;
}
.items {
  overflow-y: auto;
  flex: 1;
}
.empty {
  padding: 16px;
}
.item {
  display: flex;
  gap: 10px;
  align-items: baseline;
  width: 100%;
  text-align: left;
  border: none;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  background: none;
  padding: 10px 14px;
}
.item:hover {
  background: var(--panel-2);
}
.item.sel {
  background: color-mix(in srgb, var(--accent) 10%, var(--panel));
  box-shadow: inset 3px 0 0 var(--accent);
}
.main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.title {
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  font-size: 12px;
}
.reason {
  font-size: 12px;
  color: var(--c);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
