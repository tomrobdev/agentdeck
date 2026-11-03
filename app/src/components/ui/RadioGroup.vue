<script setup lang="ts" generic="K extends string">
import { RadioGroupItem, RadioGroupRoot } from 'reka-ui';

// A short list of choices, each with a label and a hint. Arrow keys move between them. `cards` lays them out in two
// columns, each choice a bordered card with its hint beside the label.
defineProps<{ options: { key: K; label: string; hint?: string }[]; label: string; cards?: boolean }>();
const model = defineModel<K>({ required: true });
</script>

<template>
  <RadioGroupRoot
    :model-value="model"
    :aria-label="label"
    :class="cards ? 'grid grid-cols-2 gap-1.5' : 'flex flex-col gap-1.5'"
    @update:model-value="(v) => (model = v as K)"
  >
    <label
      v-for="o in options"
      :key="o.key"
      class="flex cursor-pointer gap-2"
      :class="cards ? ['items-center rounded-sm border px-2 py-1.5', model === o.key ? 'border-accent' : 'border-border'] : 'items-start'"
    >
      <RadioGroupItem
        :value="o.key"
        class="grid size-3.5 flex-none place-items-center rounded-full border border-border bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-accent"
        :class="[cards ? '' : 'mt-1', model === o.key ? 'border-accent bg-accent' : '']"
      />
      <span v-if="cards">
        <b>{{ o.label }}</b
        ><small v-if="o.hint" class="muted text-xs"> {{ o.hint }}</small>
      </span>
      <span v-else class="flex flex-col">
        <span>{{ o.label }}</span>
        <span v-if="o.hint" class="muted text-sm">{{ o.hint }}</span>
      </span>
    </label>
  </RadioGroupRoot>
</template>
