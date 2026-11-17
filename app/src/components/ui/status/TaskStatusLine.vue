<script setup lang="ts">
import { computed } from 'vue';
import { landingApi } from '#api/landing.ts';
import type { TaskSummary } from '#api/types.ts';
import { useAction } from '#composables/shared/useActions.ts';
import { type StatusLine, TONE_TEXT, statusLine } from '#lib/work/task-badges.ts';

const props = withDefaults(
  defineProps<{ task: TaskSummary; fit?: 'line' | 'two' | 'full'; cancel?: boolean; hide?: StatusLine['kind'][] }>(),
  {
    fit: 'line',
    hide: () => [],
  },
);
const { pending, run } = useAction();

const l = computed(() => {
  const found = statusLine(props.task);
  return found && !props.hide.includes(found.kind) ? found : null;
});
const FIT = { line: 'truncate', two: 'line-clamp-2', full: 'wrap-anywhere' };
const cancelMerge = () => run(() => landingApi.cancelMergeRequest(props.task.id));
</script>

<template>
  <div v-if="l && cancel && l.cancelMerge" class="flex items-center gap-2 text-sm" :class="TONE_TEXT[l.tone]" :data-status-line="l.kind">
    <span class="min-w-0" :class="FIT[fit]" :title="l.title">{{ l.text }}</span>
    <button class="btn-mini flex-none" :disabled="pending" title="Withdraw the merge request" @click.stop="cancelMerge">
      Cancel merge
    </button>
  </div>
  <div
    v-else-if="l"
    class="min-w-0 text-sm tabular-nums"
    :class="[TONE_TEXT[l.tone], FIT[fit]]"
    :title="l.title"
    :data-status-line="l.kind"
  >
    {{ l.text }}
  </div>
</template>
