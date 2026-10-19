<script setup lang="ts">
import { computed, ref } from 'vue';
import { type TaskSummary, ago } from '../../api';
import { type BoardMove, type Group, type StatusGroup, boardMove, unblocksOf } from '../../taskView';
import PriorityIcon from './PriorityIcon.vue';
import StatusIcon from './StatusIcon.vue';

// Columns are the status groups. A drop is allowed only where it is a real lifecycle event.
const props = defineProps<{ groups: Group[]; selected: number | null; show: { repo: boolean; pr: boolean } }>();
const emit = defineEmits<{ open: [id: number]; select: [id: number]; move: [kind: BoardMove, id: number] }>();

const dragging = ref<TaskSummary | null>(null);
const over = ref<string | null>(null);

/** The move a drop on each column would make, for the card being dragged. */
const moves = computed<Record<string, BoardMove | null>>(() =>
  Object.fromEntries(props.groups.map((g) => [g.key, dragging.value ? boardMove(dragging.value, g.key as StatusGroup) : null])),
);
const canDrag = (t: TaskSummary) => t.status !== 'running' && t.status !== 'cancel_requested';

function onDragStart(e: DragEvent, t: TaskSummary) {
  dragging.value = t;
  e.dataTransfer?.setData('text/plain', String(t.id));
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}
function onDragOver(e: DragEvent, key: string) {
  if (!moves.value[key]) return;
  e.preventDefault(); // allows the drop
  over.value = key;
}
function onDrop(key: string) {
  const kind = moves.value[key];
  if (kind && dragging.value) emit('move', kind, dragging.value.id);
  end();
}
function end() {
  dragging.value = null;
  over.value = null;
}
const LABELS: Record<BoardMove, string> = {
  approve: 'Drop to approve',
  reject: 'Drop to reject',
  retry: 'Drop to retry',
  cancel: 'Drop to cancel',
};
</script>

<template>
  <div class="board">
    <section
      v-for="g in groups"
      :key="g.key"
      class="col"
      :class="{ target: !!moves[g.key], over: over === g.key }"
      @dragover="onDragOver($event, g.key)"
      @dragleave="over === g.key && (over = null)"
      @drop.prevent="onDrop(g.key)"
    >
      <header class="chead">
        <span>{{ g.label }}</span>
        <span class="muted">{{ g.tasks.length }}</span>
      </header>
      <div v-if="moves[g.key]" class="hint">{{ LABELS[moves[g.key]!] }}</div>
      <div class="cards">
        <article
          v-for="t in g.tasks"
          :key="t.id"
          class="card"
          :class="{ sel: t.id === selected, dragging: dragging?.id === t.id }"
          :draggable="canDrag(t)"
          :title="canDrag(t) ? '' : 'A running task can only be stopped from its page'"
          @dragstart="onDragStart($event, t)"
          @dragend="end"
          @click="emit('open', t.id)"
          @mouseenter="emit('select', t.id)"
        >
          <div class="top">
            <span class="id">#{{ t.id }}</span>
            <PriorityIcon :priority="t.priority" />
            <div class="spacer" />
            <StatusIcon :task="t" />
          </div>
          <div class="title">{{ t.title }}</div>
          <div class="chips">
            <span v-if="show.repo" class="chip">{{ t.repo }}</span>
            <span v-if="show.pr && t.pr_url" class="chip">PR {{ t.pr_state ?? 'open' }}</span>
            <span v-if="t.waiting" class="chip">{{ t.waiting.stuck ? 'stuck' : `waiting #${t.waiting.on}` }}</span>
            <span v-if="unblocksOf(t).length" class="chip"
              >unblocks
              {{
                unblocksOf(t)
                  .map((id) => `#${id}`)
                  .join(' ')
              }}</span
            >
            <span v-if="t.source === 'planner'" class="chip">planner</span>
            <span class="time muted">{{ ago(t.updated_at) }}</span>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>

<style scoped>
.board {
  display: flex;
  gap: 10px;
  padding: 12px 16px;
  overflow-x: auto;
  flex: 1;
  min-height: 0;
}
.col {
  display: flex;
  flex-direction: column;
  flex: 0 0 260px;
  min-height: 0;
  background: var(--panel-2);
  border: 1px solid transparent;
  border-radius: 10px;
}
.col.target {
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  border-style: dashed;
}
.col.over {
  background: color-mix(in srgb, var(--accent) 10%, var(--panel-2));
}
.chead {
  display: flex;
  gap: 8px;
  padding: 10px 12px 6px;
  font-weight: 600;
}
.hint {
  font-size: 12px;
  color: var(--accent);
  padding: 0 12px 6px;
}
.cards {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 8px 10px;
  overflow-y: auto;
}
.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  cursor: pointer;
}
.card.sel {
  border-color: var(--accent);
}
.card.dragging {
  opacity: 0.5;
}
.top {
  display: flex;
  align-items: center;
  gap: 6px;
}
.id {
  color: var(--muted);
  font-size: 12px;
}
.spacer {
  flex: 1;
}
.title {
  margin: 4px 0 6px;
  font-weight: 500;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
.chip {
  font-size: 11.5px;
  padding: 0 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--muted);
}
.time {
  margin-left: auto;
  font-size: 12px;
}
</style>
