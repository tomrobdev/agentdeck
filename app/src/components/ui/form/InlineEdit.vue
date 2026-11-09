<script setup lang="ts">
import { EditableArea, EditableInput, EditablePreview, EditableRoot } from 'reka-ui';

// A value edited in place. The preview (the default slot, or `value`) is focusable, so Tab reaches it and focus opens the
// input; Enter or leaving it submits, and Escape cancels. The caller owns the value: if a save fails and `value` stays
// the same, the saved value shows again.
defineProps<{ value: string; label: string; disabled?: boolean; type?: 'text' | 'number'; previewClass?: string; inputClass?: string }>();
const emit = defineEmits<{ submit: [value: string] }>();
</script>

<template>
  <EditableRoot
    :model-value="value"
    :disabled="disabled"
    submit-mode="both"
    select-on-focus
    placeholder=""
    class="min-w-0 flex-1"
    @submit="(v) => emit('submit', v ?? '')"
  >
    <EditableArea class="flex min-w-0">
      <EditablePreview :class="previewClass" :aria-label="label" role="button"><slot /></EditablePreview>
      <EditableInput :type="type ?? 'text'" :class="inputClass" :aria-label="label" @keydown.esc.stop />
    </EditableArea>
  </EditableRoot>
</template>
