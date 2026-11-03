<script setup lang="ts">
import { computed, ref } from 'vue';
import { type TaskSummary, ago } from '../../api';
import { mergeAllIds } from '../../lib/bulk';
import { type BoardMove, type Group, type StatusGroup, boardMove, isReview } from '../../lib/taskView';
import MarkDoneDialog from '../task/MarkDoneDialog.vue';
import MergeButtons from './MergeButtons.vue';
import PriorityIcon from '../ui/PriorityIcon.vue';
import StatusIcon from '../ui/StatusIcon.vue';
import TaskBadges from '../ui/TaskBadges.vue';
import TaskStatusLine from '../ui/TaskStatusLine.vue';

// Columns are the status groups. A drop is allowed only where it is a real lifecycle event.
const props = defineProps<{
  groups: Group[];
  selected: number | null;
  show: { repo: boolean; pr: boolean };
}>();
const emit = defineEmits<{
  open: [id: number];
  select: [id: number];
  move: [kind: BoardMove, id: number];
  merge: [id: number];
  mergeAll: [ids: number[]];
}>();

const dragging = ref<TaskSummary | null>(null);
const over = ref<string | null>(null);

/** The move a drop on each column would make, for the card being dragged. */
const moves = computed<Record<string, BoardMove | null>>(() =>
  Object.fromEntries(props.groups.map((g) => [g.key, dragging.value ? boardMove(dragging.value, g.key as StatusGroup) : null])),
);
const canDrag = (t: TaskSummary) => t.status !== 'running' && t.status !== 'cancel_requested' && !t.sync;

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
/** The task a drop is waiting to mark done: that move asks first. */
const confirming = ref<TaskSummary | null>(null);
function onDrop(key: string) {
  const kind = moves.value[key];
  if (kind === 'mark_done') confirming.value = dragging.value;
  else if (kind && dragging.value) emit('move', kind, dragging.value.id);
  end();
}
function confirmDone() {
  if (confirming.value) emit('move', 'mark_done', confirming.value.id);
  confirming.value = null;
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
  mark_done: 'Drop to mark done',
  merge: 'Drop to merge',
};
</script>

<template>
  <div class="flex min-h-0 flex-1 gap-2.5 overflow-x-auto px-4 py-3">
    <section
      v-for="g in groups"
      :key="g.key"
      class="flex min-h-0 flex-none basis-[260px] flex-col rounded-[10px] border"
      :class="[
        moves[g.key] ? 'border-dashed border-[color-mix(in_srgb,var(--accent)_40%,transparent)]' : 'border-transparent',
        over === g.key ? 'bg-[color-mix(in_srgb,var(--accent)_10%,var(--panel-2))]' : 'bg-panel-2',
      ]"
      @dragover="onDragOver($event, g.key)"
      @dragleave="over === g.key && (over = null)"
      @drop.prevent="onDrop(g.key)"
    >
      <header class="flex items-center gap-2 px-3 pt-2.5 pb-1.5 font-semibold">
        <span>{{ g.label }}</span>
        <span class="text-muted">{{ g.tasks.length }}</span>
        <button
          v-if="mergeAllIds(g).length"
          class="btn-mini ml-auto font-normal"
          title="Merge every pull request in this column, each with its task's method"
          @click="emit('mergeAll', mergeAllIds(g))"
        >
          Merge all
        </button>
      </header>
      <div v-if="moves[g.key]" class="px-3 pb-1.5 text-sm text-accent">{{ LABELS[moves[g.key]!] }}</div>
      <div class="flex flex-col gap-1.5 overflow-y-auto px-2 pb-2.5">
        <article
          v-for="t in g.tasks"
          :key="t.id"
          class="group cursor-pointer rounded-md border bg-panel px-2.5 py-2"
          :class="[t.id === selected ? 'border-accent' : 'border-border', dragging?.id === t.id ? 'opacity-50' : '']"
          :draggable="canDrag(t)"
          :title="
            canDrag(t)
              ? ''
              : t.sync
                ? 'A task that is syncing can be moved when that is done'
                : 'A running task can only be stopped from its page'
          "
          @dragstart="onDragStart($event, t)"
          @dragend="end"
          @click="emit('open', t.id)"
          @mouseenter="emit('select', t.id)"
        >
          <div class="flex items-center gap-1.5">
            <span class="font-mono text-sm text-muted">#{{ t.id }}</span>
            <PriorityIcon :priority="t.priority" />
            <div class="spacer" />
            <StatusIcon :task="t" />
          </div>
          <div class="mt-1 mb-1.5 line-clamp-2 font-medium">{{ t.title }}</div>
          <TaskStatusLine :task="t" fit="two" class="mb-1.5" />
          <div class="flex items-center gap-2">
            <TaskBadges :task="t" :repo="show.repo" :pr="show.pr" class="flex-1" />
            <span class="ml-auto flex-none text-sm text-muted">{{ ago(t.updated_at) }}</span>
          </div>
          <div
            v-if="isReview(t) && !t.sync"
            class="mt-1.5 gap-1"
            :class="t.id === selected ? 'flex' : 'hidden group-hover:flex'"
            @click.stop
          >
            <MergeButtons :task="t" @merge="emit('merge', $event)" />
          </div>
        </article>
      </div>
    </section>
    <MarkDoneDialog v-if="confirming" :task="confirming" @close="confirming = null" @confirm="confirmDone" />
  </div>
</template>
