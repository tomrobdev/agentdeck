<script setup lang="ts">
import { computed } from 'vue';
import type { TaskSummary } from '../../api';
import { isStuck, isWaiting } from '../../lib/taskView';

// Each state has its own shape as well as its colour, so it reads without colour too.
const props = defineProps<{ task: Pick<TaskSummary, 'status' | 'waiting'>; size?: number }>();

const kind = computed(() => {
  const t = props.task as TaskSummary;
  if (isStuck(t)) return 'stuck';
  if (isWaiting(t)) return 'waiting';
  return t.status;
});
const TITLES: Record<string, string> = {
  proposed: 'Proposed',
  queued: 'Queued',
  waiting: 'Waiting on another task',
  stuck: 'Stuck: its dependency needs you',
  running: 'Running',
  cancel_requested: 'Stopping',
  done: 'Done',
  blocked: 'Blocked',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
</script>

<template>
  <svg
    class="block flex-none"
    :class="`s-${task.status}`"
    :width="size ?? 14"
    :height="size ?? 14"
    viewBox="0 0 14 14"
    role="img"
    :aria-label="TITLES[kind]"
  >
    <title>{{ TITLES[kind] }}</title>
    <circle v-if="kind === 'proposed'" cx="7" cy="7" r="5.5" fill="none" stroke="var(--c)" stroke-width="1.5" stroke-dasharray="2 2" />
    <template v-else-if="kind === 'queued'">
      <circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--c)" stroke-width="1.5" />
    </template>
    <template v-else-if="kind === 'waiting'">
      <circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--c)" stroke-width="1.5" />
      <path d="M7 4.2V7l1.8 1.2" fill="none" stroke="var(--c)" stroke-width="1.3" stroke-linecap="round" />
    </template>
    <template v-else-if="kind === 'running' || kind === 'cancel_requested'">
      <circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--c)" stroke-width="1.5" />
      <path d="M7 3.5A3.5 3.5 0 0 1 7 10.5Z" fill="var(--c)" />
    </template>
    <template v-else-if="kind === 'done'">
      <circle cx="7" cy="7" r="6.2" fill="var(--c)" />
      <path
        d="M4.3 7.2l1.8 1.8 3.6-3.8"
        fill="none"
        stroke="var(--panel)"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </template>
    <template v-else-if="kind === 'failed'">
      <circle cx="7" cy="7" r="6.2" fill="var(--c)" />
      <path d="M4.8 4.8l4.4 4.4M9.2 4.8l-4.4 4.4" stroke="var(--panel)" stroke-width="1.5" stroke-linecap="round" />
    </template>
    <template v-else-if="kind === 'blocked' || kind === 'stuck'">
      <circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--blocked)" stroke-width="1.5" />
      <path d="M7 4v3.6" stroke="var(--blocked)" stroke-width="1.6" stroke-linecap="round" />
      <circle cx="7" cy="9.8" r="0.9" fill="var(--blocked)" />
    </template>
    <template v-else>
      <circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--c)" stroke-width="1.5" />
      <path d="M3.4 10.6l7.2-7.2" stroke="var(--c)" stroke-width="1.5" />
    </template>
  </svg>
</template>
