<script setup lang="ts" generic="K extends string">
import { RadioGroupItem, RadioGroupRoot } from 'reka-ui';

// A short list of choices, each with a label and a hint underneath. Arrow keys move between them.
defineProps<{ options: { key: K; label: string; hint?: string }[]; label: string }>();
const model = defineModel<K>({ required: true });
</script>

<template>
  <RadioGroupRoot v-model="model" :aria-label="label" class="flex flex-col gap-1.5">
    <label v-for="o in options" :key="o.key" class="flex cursor-pointer items-start gap-2">
      <RadioGroupItem
        :value="o.key"
        class="mt-1 grid size-3.5 flex-none place-items-center rounded-full border border-border bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-accent"
        :class="model === o.key ? 'border-accent bg-accent' : ''"
      />
      <span class="flex flex-col">
        <span>{{ o.label }}</span>
        <span v-if="o.hint" class="muted text-sm">{{ o.hint }}</span>
      </span>
    </label>
  </RadioGroupRoot>
</template>
