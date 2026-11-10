<script setup lang="ts" generic="V extends string | number, O extends { value: V }">
import { ListboxContent, ListboxItem, ListboxRoot } from 'reka-ui';

defineProps<{ options: O[]; label: string; itemClass?: string }>();
const model = defineModel<V>({ required: true });
</script>

<template>
  <ListboxRoot
    :model-value="model"
    selection-behavior="replace"
    :aria-label="label"
    @update:model-value="(v) => v != null && (model = v as V)"
  >
    <ListboxContent class="flex flex-col">
      <ListboxItem
        v-for="o in options"
        :key="o.value"
        :value="o.value"
        class="cursor-pointer data-[highlighted]:outline-2 data-[highlighted]:-outline-offset-2 data-[highlighted]:outline-accent"
        :class="itemClass"
      >
        <slot :option="o" :selected="o.value === model" />
      </ListboxItem>
    </ListboxContent>
  </ListboxRoot>
</template>
