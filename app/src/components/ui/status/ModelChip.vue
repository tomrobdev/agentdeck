<script setup lang="ts">
import { computed } from 'vue';
import type { TaskSummary } from '#api/types.ts';
import { modelChip } from '#lib/work/queue/peek.ts';
import Chip from '#components/ui/Chip.vue';

const props = defineProps<{ task: Pick<TaskSummary, 'model' | 'run_model'> }>();
const chip = computed(() => modelChip(props.task));
const escalated = computed(() => !!props.task.run_model && props.task.run_model !== props.task.model);
</script>

<template>
  <Chip size="xs" :tone="escalated ? 'accent' : 'muted'" :title="chip.title" data-model-chip>{{ chip.text }}</Chip>
</template>
