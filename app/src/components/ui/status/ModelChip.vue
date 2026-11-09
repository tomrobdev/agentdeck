<script setup lang="ts">
import { computed } from 'vue';
import type { TaskSummary } from '../../../api/types';
import { modelChip } from '../../../lib/queue/peek';
import Chip from '../Chip.vue';

// A task's model as a small chip on a row or card: the latest run's when it differs from the task's, in the accent tone.
const props = defineProps<{ task: Pick<TaskSummary, 'model' | 'run_model'> }>();
const chip = computed(() => modelChip(props.task));
const escalated = computed(() => !!props.task.run_model && props.task.run_model !== props.task.model);
</script>

<template>
  <Chip size="xs" :tone="escalated ? 'accent' : 'muted'" :title="chip.title" data-model-chip>{{ chip.text }}</Chip>
</template>
