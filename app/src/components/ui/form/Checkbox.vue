<script setup lang="ts">
import { CheckboxIndicator, CheckboxRoot } from 'reka-ui';

defineProps<{ label?: string }>();
const model = defineModel<boolean>({ required: true });
</script>

<template>
  <label class="check">
    <CheckboxRoot
      :model-value="model"
      :aria-label="label"
      class="grid size-3.5 flex-none place-items-center rounded-[3px] border border-border bg-transparent p-0 text-[10px] leading-none text-bg focus-visible:outline-2 focus-visible:outline-accent data-[state=checked]:border-accent data-[state=checked]:bg-accent"
      @update:model-value="(v) => (model = v === true)"
    >
      <CheckboxIndicator>✓</CheckboxIndicator>
    </CheckboxRoot>
    <slot />
  </label>
</template>
