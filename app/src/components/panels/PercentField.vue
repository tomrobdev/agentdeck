<script setup lang="ts">
import NumberInput from '../ui/form/NumberInput.vue';

defineProps<{ label: string; hint: string }>();
const model = defineModel<number>({ required: true });
</script>

<template>
  <label class="field">
    <span>{{ label }}</span>
    <span class="flex items-center gap-1.5 [&_input]:w-20"><NumberInput v-model="model" />%</span>
    <small class="text-muted text-xs">{{ hint }}</small>
  </label>
</template>
