<script setup lang="ts">
import type { TaskSummary } from '../../api';
import { statusText } from '../../lib/taskBadges';
import StatusIcon from './StatusIcon.vue';

// A task's status as a pill in its colour: "in review" for a done task whose PR is open.
defineProps<{ task: TaskSummary }>();
</script>

<template>
  <span
    class="inline-flex flex-none items-center gap-[5px] rounded-full bg-[color-mix(in_srgb,var(--c)_16%,var(--panel))] px-2.5 py-0.5 text-sm font-medium whitespace-nowrap text-status"
    :class="`s-${task.status}`"
    ><StatusIcon :task="task" :size="12" /> {{ statusText(task) }}</span
  >
</template>
