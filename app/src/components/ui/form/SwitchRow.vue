<script setup lang="ts">
import FieldRow from '#components/ui/form/FieldRow.vue';
import Switch from '#components/ui/form/Switch.vue';

defineOptions({ inheritAttrs: false });
defineProps<{ label: string; hint?: string }>();
const model = defineModel<boolean>({ required: true });
</script>

<template>
  <FieldRow as="div" :label="label" :hint="hint">
    <Switch v-model="model" :label="label" v-bind="$attrs" />
  </FieldRow>
</template>
