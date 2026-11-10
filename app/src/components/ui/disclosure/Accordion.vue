<script setup lang="ts">
import { AccordionRoot } from 'reka-ui';

defineProps<{ as?: string }>();
const model = defineModel<string | undefined>();
</script>

<template>
  <AccordionRoot
    type="single"
    collapsible
    :as="as"
    :model-value="model"
    @update:model-value="(v) => (model = (Array.isArray(v) ? v[0] : v) || undefined)"
  >
    <slot />
  </AccordionRoot>
</template>
