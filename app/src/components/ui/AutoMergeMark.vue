<script setup lang="ts">
import type { AutoMergeView } from '../../api';
import { AUTO_MERGE_CHIP, autoMergeTip } from '../../lib/taskView';

// A small chip for a task's auto-merge state, coloured by state. The label and reasons are the daemon's words.
defineProps<{ view?: AutoMergeView | null }>();
</script>

<template>
  <span
    v-if="view && view.state !== 'off'"
    class="chip max-w-[200px] truncate align-middle"
    :class="AUTO_MERGE_CHIP[view.state]"
    :title="autoMergeTip(view)"
    :data-auto-merge="view.state"
    >{{ view.label }}</span
  >
</template>
