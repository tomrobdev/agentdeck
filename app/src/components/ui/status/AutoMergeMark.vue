<script setup lang="ts">
import type { AutoMergeView } from '../../../api/types';
import { AUTO_MERGE_CHIP } from '../../../lib/work/task-badges';
import { autoMergeTip } from '../../../lib/work/task-view';
import Chip from '../Chip.vue';
import Tooltip from '../Tooltip.vue';

defineProps<{ view?: AutoMergeView | null }>();
</script>

<template>
  <Tooltip v-if="view && view.state !== 'off'" :text="autoMergeTip(view)">
    <Chip class="max-w-[200px] truncate align-middle" :tone="AUTO_MERGE_CHIP[view.state]" tabindex="0" :data-auto-merge="view.state">{{
      view.label
    }}</Chip>
  </Tooltip>
</template>
