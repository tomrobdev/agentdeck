<script setup lang="ts">
import FieldRow from '#components/ui/form/FieldRow.vue';
import NumberInput from '#components/ui/form/NumberInput.vue';

defineProps<{ label: string; hint: string }>();
const model = defineModel<number>({ required: true });
</script>

<template>
  <FieldRow :label="label" :hint="hint">
    <span class="flex items-center gap-1.5"><NumberInput class="w-24" v-model="model" />%</span>
  </FieldRow>
</template>
