<script setup lang="ts">
import { AccordionRoot } from 'reka-ui';

// Parts of which one is open at a time, or none (a click on the open one closes it). The value is the open item's value.
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
