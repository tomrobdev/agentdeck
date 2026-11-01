<script setup lang="ts">
import type { BulkAction } from '../../lib/bulk';

defineProps<{ count: number; actions: BulkAction[]; busy: boolean }>();
const emit = defineEmits<{ act: [action: BulkAction]; clear: [] }>();

const LABELS: Record<BulkAction, string> = { approve: 'Approve', reject: 'Reject', retry: 'Retry', merge: 'Merge', cancel: 'Cancel' };
</script>

<template>
  <div class="flex items-center gap-2 border-t border-border bg-panel-2 px-4 py-2" role="toolbar" aria-label="Selected tasks">
    <span class="font-semibold">{{ count }} selected</span>
    <button v-for="a in actions" :key="a" class="btn-mini" :disabled="busy" @click="emit('act', a)">{{ LABELS[a] }}</button>
    <span v-if="!actions.length" class="muted text-sm">No action fits all of them</span>
    <span class="flex-1" />
    <button class="btn-mini" title="Clear (Esc)" @click="emit('clear')">Clear</button>
  </div>
</template>
