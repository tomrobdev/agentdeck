<script setup lang="ts">
import { computed } from 'vue';
import { CollapsibleRoot } from 'reka-ui';

const props = defineProps<{ as?: string; defaultOpen?: boolean }>();
const model = defineModel<boolean | undefined>('open', { default: undefined });
const open = computed({ get: () => model.value ?? props.defaultOpen, set: (v) => (model.value = v) });
</script>

<template>
  <CollapsibleRoot v-model:open="open" :as="as"><slot :open="open" /></CollapsibleRoot>
</template>
