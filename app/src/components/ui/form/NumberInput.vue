<script setup lang="ts">
import { NumberFieldInput, NumberFieldRoot } from 'reka-ui';

defineProps<{ label?: string; step?: number; placeholder?: string }>();
const model = defineModel<number>({ required: true });
</script>

<template>
  <NumberFieldRoot
    :model-value="Number.isNaN(model) ? undefined : model"
    :step="step ?? 1"
    :step-snapping="false"
    allow-invalid
    :format-options="{ maximumFractionDigits: 4, useGrouping: false }"
    @update:model-value="(v) => (model = v ?? NaN)"
  >
    <NumberFieldInput :aria-label="label" :placeholder="placeholder" class="w-full" />
  </NumberFieldRoot>
</template>
