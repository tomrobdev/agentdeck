<script setup lang="ts" generic="V extends string | number">
import { ComboboxContent, ComboboxInput, ComboboxItem, ComboboxRoot, ComboboxViewport } from 'reka-ui';

// A search box with a list of matches under it. The caller filters (`options` are the matches for `search`). ArrowDown and
// ArrowUp move the highlight, Enter or a click picks the highlighted match (`pick`), and Escape closes the list. With no
// highlighted match, Enter goes to the form around it. Takes focus when mounted.
defineProps<{ options: { value: V; label: string }[]; label: string; placeholder?: string }>();
const search = defineModel<string>('search', { required: true });
const emit = defineEmits<{ pick: [value: V] }>();
</script>

<template>
  <!-- Nothing stays chosen (model-value is always null), so picking the same match again, after a refusal, picks it again. -->
  <ComboboxRoot :model-value="null" ignore-filter class="min-w-0 flex-1" @update:model-value="(v) => v != null && emit('pick', v as V)">
    <ComboboxInput v-model="search" auto-focus :aria-label="label" :placeholder="placeholder" class="w-full px-1.5 py-0.5" />
    <ComboboxContent v-if="options.length" class="mt-1">
      <ComboboxViewport class="flex flex-col">
        <ComboboxItem
          v-for="o in options"
          :key="o.value"
          :value="o.value"
          class="flex w-full cursor-pointer items-center gap-2 rounded-sm px-1 py-0.5 data-[highlighted]:bg-panel-2 data-[highlighted]:text-accent"
        >
          <slot name="option" :option="o">{{ o.label }}</slot>
        </ComboboxItem>
      </ComboboxViewport>
    </ComboboxContent>
  </ComboboxRoot>
</template>
