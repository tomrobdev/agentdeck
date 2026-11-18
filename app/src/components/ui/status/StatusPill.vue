<script setup lang="ts">
import type { TaskSummary } from '#api/types.ts';
import { statusText } from '#lib/work/task-badges.ts';
import Chip from '#components/ui/Chip.vue';
import StatusIcon from '#components/ui/status/StatusIcon.vue';

defineProps<{ task: TaskSummary }>();
</script>

<template>
  <Chip :status="task.status" variant="tint" :class="`s-${task.status}`" class="flex-none font-medium"
    ><StatusIcon :task="task" :size="12" /> {{ statusText(task) }}</Chip
  >
</template>
