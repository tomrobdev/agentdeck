<script setup lang="ts">
import type { TaskSummary } from '../../../api/types';
import { statusText } from '../../../lib/work/task-badges';
import Chip from '../Chip.vue';
import StatusIcon from './StatusIcon.vue';

defineProps<{ task: TaskSummary }>();
</script>

<template>
  <Chip :status="task.status" variant="tint" :class="`s-${task.status}`" class="flex-none font-medium"
    ><StatusIcon :task="task" :size="12" /> {{ statusText(task) }}</Chip
  >
</template>
