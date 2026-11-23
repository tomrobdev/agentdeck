<script setup lang="ts">
import { CollapsibleRoot } from 'reka-ui';

defineProps<{ as?: string; defaultOpen?: boolean }>();
const model = defineModel<boolean | undefined>('open', { default: undefined });
</script>

<template>
  <CollapsibleRoot v-slot="{ open }" v-model:open="model" :default-open="defaultOpen" :as="as"><slot :open="open" /></CollapsibleRoot>
</template>
