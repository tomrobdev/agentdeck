<script setup lang="ts">
import { computed } from 'vue';
import { type Segment, type SegmentKind, type Tick, placeSegment, stripShare } from '../../lib/runs/run-live';

const props = defineProps<{ segments: Segment[]; ticks: Tick[]; start: number; end: number }>();
const emit = defineEmits<{ jump: [at: string] }>();

const COLOUR: Record<SegmentKind, string> = {
  read: 'bg-tool-read',
  edit: 'bg-tool-edit',
  command: 'bg-tool-cmd',
  test: 'bg-accent',
  write: 'bg-muted/40',
};
const placed = computed(() => props.segments.map((s) => ({ s, ...placeSegment(s, props.start, props.end) })));
const marks = computed(() => props.ticks.map((t) => ({ t, left: t.ms === null ? 100 : stripShare(t.ms, props.start, props.end) })));
</script>

<template>
  <div class="relative h-5 flex-none border-b border-border bg-panel" role="group" aria-label="Timeline of the run">
    <button
      v-for="p in placed"
      :key="p.s.at + p.s.from"
      class="absolute top-1 bottom-1 min-w-px rounded-none border-0 p-0"
      :class="COLOUR[p.s.kind]"
      :style="{ left: `${p.left}%`, width: `${p.width}%` }"
      :title="p.s.label"
      :aria-label="p.s.label"
      @click="emit('jump', p.s.at)"
    />
    <component
      :is="m.t.at ? 'button' : 'span'"
      v-for="(m, i) in marks"
      :key="`t${i}`"
      class="absolute top-0 bottom-0 w-0.5 -translate-x-1/2 border-0 p-0"
      :class="m.t.failed ? 'bg-failed' : 'bg-done'"
      :style="{ left: `${m.left}%` }"
      :title="m.t.label"
      @click="m.t.at && emit('jump', m.t.at)"
    />
  </div>
</template>
