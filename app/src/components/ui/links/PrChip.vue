<script setup lang="ts">
import { computed } from 'vue';
import type { TaskSummary } from '#api/types.ts';
import { prChip } from '#lib/work/task-badges.ts';
import GitHubLink from '#components/ui/links/GitHubLink.vue';

const props = defineProps<{ task: Pick<TaskSummary, 'pr_url' | 'pr_state' | 'checks'>; plain?: boolean }>();
const chip = computed(() => prChip(props.task));
const PULL =
  'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354Z';
</script>

<template>
  <GitHubLink
    v-if="chip"
    class="flex-none"
    :url="chip.url"
    :label="chip.label"
    :tip="chip.title"
    :icon="PULL"
    :tone="chip.tone"
    :plain="plain"
    data-pr-chip
  />
</template>
