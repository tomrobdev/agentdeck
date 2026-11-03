<script setup lang="ts">
import InlineEdit from '../ui/InlineEdit.vue';
import { input, name, prop, row, rowButton, rowButtonEditable } from './sidebarStyle';

// One sidebar property that a person may edit while the task is editable: an inline edit, else the same value read-only.
// The default slot is the value as shown; without one, the value itself.
defineProps<{ label: string; value: string; editable: boolean; type?: 'number' }>();
const emit = defineEmits<{ submit: [value: string] }>();
</script>

<template>
  <div :class="prop">
    <div :class="name">{{ label }}</div>
    <InlineEdit
      v-if="editable"
      :label="label"
      :type="type"
      :value="value"
      :preview-class="`${rowButton} ${rowButtonEditable} cursor-pointer`"
      :input-class="input"
      @submit="(v) => emit('submit', v)"
    >
      <slot>{{ value }}</slot>
    </InlineEdit>
    <div v-else :class="row">
      <slot>{{ value }}</slot>
    </div>
  </div>
</template>
