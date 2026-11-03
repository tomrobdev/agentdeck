<script setup lang="ts">
import type { AutoMergeView } from '../../api';
import { AUTO_MERGE_CHIP } from '../../lib/taskBadges';
import { autoMergeTip } from '../../lib/taskView';
import Chip from './Chip.vue';

// A small chip for a task's auto-merge state, coloured by state, in the task page's sidebar. The label and reasons are the
// daemon's words. Everywhere else a task's auto-merge is on its status line or a TaskBadges chip (lib/taskBadges.ts).
defineProps<{ view?: AutoMergeView | null }>();
</script>

<template>
  <Chip
    v-if="view && view.state !== 'off'"
    class="max-w-[200px] truncate align-middle"
    :tone="AUTO_MERGE_CHIP[view.state]"
    :title="autoMergeTip(view)"
    :data-auto-merge="view.state"
    >{{ view.label }}</Chip
  >
</template>
