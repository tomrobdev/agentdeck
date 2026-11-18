<script setup lang="ts">
import { computed } from 'vue';
import { type RunHeader, clock } from '#lib/runs/run-live.ts';
import Progress from '#components/ui/status/Progress.vue';
import Switch from '#components/ui/form/Switch.vue';

const props = defineProps<{ header: RunHeader; following: boolean }>();
const emit = defineEmits<{ follow: [on: boolean] }>();
const turns = computed(() =>
  props.header.maxTurns ? `${props.header.turns}/${props.header.maxTurns} turns` : `${props.header.turns} turns`,
);
</script>

<template>
  <div class="flex flex-none items-center gap-3 border-b border-border bg-panel px-3.5 py-1.5 text-sm">
    <span v-if="header.ended" class="font-semibold" :class="header.outcome === 'done' ? 'text-done' : 'text-muted'">{{
      header.outcome
    }}</span>
    <Progress
      v-if="header.maxTurns"
      class="h-1.5 w-28 flex-none overflow-hidden rounded-full bg-border"
      indicator-class="bg-running"
      label="Turns used"
      :value="header.turns"
      :max="header.maxTurns"
    />
    <span class="tabular-nums">{{ turns }}</span>
    <span v-if="!header.ended && header.tool" class="min-w-0 truncate text-muted">
      <b class="font-semibold text-text">{{ header.tool }}</b
      ><template v-if="header.toolSeconds !== null"> · {{ clock(header.toolSeconds) }}</template>
    </span>
    <span class="ml-auto text-muted tabular-nums">{{ clock(header.seconds) }}</span>
    <Switch v-if="!header.ended" label="Follow the log" :model-value="following" @update:model-value="(on) => emit('follow', on)"
      >Follow</Switch
    >
  </div>
</template>
