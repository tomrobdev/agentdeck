<script setup lang="ts">
import { computed, ref } from 'vue';
import type { TaskSummary } from '../../../api/types';
import { DEFAULT_SIZE, chainOf, edgesOf, graphTasks, layoutGraph, stuckSet } from '../../../lib/work/queue/graph';
import { cut } from '../../../../../daemon/src/domain/shared/index.ts';
import StatusIcon from '../../ui/status/StatusIcon.vue';

const props = defineProps<{
  all: TaskSummary[];
  shown: TaskSummary[];
  selected: number | null;
  showFinished: boolean;
  picked?: number[];
}>();
const emit = defineEmits<{ open: [id: number]; select: [id: number]; pickChain: [id: number] }>();

function onClick(e: MouseEvent, id: number) {
  emit('select', id);
  if (e.shiftKey) emit('pickChain', id);
  else emit('open', id);
}

const PAD = 16;
const { nodeWidth: W, nodeHeight: H } = DEFAULT_SIZE;
const hover = ref<number | null>(null);

const tasks = computed(() => graphTasks(props.all, props.shown, props.showFinished));
const byId = computed(() => new Map<number, TaskSummary>(tasks.value.map((t) => [t.id, t])));
const layout = computed(() =>
  layoutGraph(
    tasks.value.map((t) => t.id),
    edgesOf(tasks.value),
  ),
);
const stuck = computed(() => stuckSet(props.all));
const pos = computed(() => new Map(layout.value.nodes.map((n) => [n.id, n])));
const lit = computed(() => (hover.value === null ? null : chainOf(hover.value, layout.value.edges)));

function path(from: number, to: number): string {
  const a = pos.value.get(from);
  const b = pos.value.get(to);
  if (!a || !b) return '';
  const x1 = a.x + W + PAD;
  const y1 = a.y + H / 2 + PAD;
  const x2 = b.x + PAD;
  const y2 = b.y + H / 2 + PAD;
  const dx = Math.max(24, (x2 - x1) / 2);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}
const edgeStuck = (from: number, to: number, kind: string) => kind === 'builds_on' && stuck.value.has(from) && stuck.value.has(to);
const dim = (id: number) => lit.value !== null && !lit.value.has(id);
</script>

<template>
  <p v-if="!tasks.length" class="text-muted px-4 py-6">
    No linked tasks to draw. Link a task to another from its card; tasks with no links stay out of the graph.
  </p>
  <div v-else class="min-h-0 flex-1 overflow-auto px-2 py-2">
    <svg :width="layout.width + PAD * 2" :height="layout.height + PAD * 2" role="group" aria-label="Task dependency graph">
      <defs>
        <marker id="graph-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L8,4 L0,8 Z" fill="var(--muted)" />
        </marker>
        <marker id="graph-arrow-stuck" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L8,4 L0,8 Z" fill="var(--blocked)" />
        </marker>
      </defs>
      <path
        v-for="e in layout.edges"
        :key="`${e.from}-${e.to}`"
        :d="path(e.from, e.to)"
        fill="none"
        :stroke="edgeStuck(e.from, e.to, e.kind) ? 'var(--blocked)' : 'var(--muted)'"
        :stroke-width="lit && lit.has(e.from) && lit.has(e.to) ? 2.2 : 1.4"
        :stroke-dasharray="e.kind === 'after' ? '5 4' : undefined"
        :marker-end="edgeStuck(e.from, e.to, e.kind) ? 'url(#graph-arrow-stuck)' : 'url(#graph-arrow)'"
        :opacity="lit && !(lit.has(e.from) && lit.has(e.to)) ? 0.2 : 1"
        :data-kind="e.kind"
      >
        <title>{{ e.kind === 'builds_on' ? `#${e.to} builds on #${e.from}` : `#${e.to} lands after #${e.from}` }}</title>
      </path>
      <g
        v-for="n in layout.nodes"
        :key="n.id"
        class="cursor-pointer"
        :class="`s-${byId.get(n.id)!.status}`"
        :transform="`translate(${n.x + PAD} ${n.y + PAD})`"
        :opacity="dim(n.id) ? 0.35 : 1"
        :data-stuck="stuck.has(n.id) || undefined"
        tabindex="0"
        role="button"
        @click="onClick($event, n.id)"
        @focus="emit('select', n.id)"
        @keydown.enter.prevent="emit('open', n.id)"
        @mouseenter="hover = n.id"
        @mouseleave="hover = null"
      >
        <rect
          :width="W"
          :height="H"
          rx="6"
          :fill="picked?.includes(n.id) ? 'color-mix(in srgb, var(--accent) 18%, var(--panel-2))' : 'var(--panel-2)'"
          :stroke="stuck.has(n.id) ? 'var(--blocked)' : selected === n.id || picked?.includes(n.id) ? 'var(--accent)' : 'var(--border)'"
          :stroke-width="stuck.has(n.id) || selected === n.id ? 2 : 1"
        />
        <rect width="4" :height="H" rx="2" fill="var(--c)" />
        <StatusIcon :task="byId.get(n.id)!" :size="14" :x="12" :y="9" />
        <text x="32" y="20" font-size="12" font-weight="600" fill="var(--text)">
          <tspan font-family="var(--font-mono)">#{{ n.id }}</tspan>
          {{ cut(byId.get(n.id)!.title, 22) }}
        </text>
        <text x="32" y="36" font-size="11" fill="var(--muted)">{{ cut(byId.get(n.id)!.repo ?? '', 28) }}</text>
        <title>{{ byId.get(n.id)!.title }}{{ stuck.has(n.id) ? ' (stuck chain)' : '' }}</title>
      </g>
    </svg>
  </div>
</template>
