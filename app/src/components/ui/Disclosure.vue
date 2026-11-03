<script setup lang="ts">
import { CollapsibleRoot } from 'reka-ui';

// One part that opens and closes. Put a DisclosureTrigger and a DisclosureContent inside; `open` can be bound
// when the page also opens it by itself.
defineProps<{ as?: string }>();
const open = defineModel<boolean>('open', { default: false });
</script>

<template>
  <CollapsibleRoot v-model:open="open" :as="as"><slot :open="open" /></CollapsibleRoot>
</template>
