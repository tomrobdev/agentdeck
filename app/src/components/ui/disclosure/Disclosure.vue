<script setup lang="ts">
import { CollapsibleRoot } from 'reka-ui';

defineProps<{ as?: string }>();
const open = defineModel<boolean>('open', { default: false });
</script>

<template>
  <CollapsibleRoot v-model:open="open" :as="as"><slot :open="open" /></CollapsibleRoot>
</template>
