<script setup lang="ts">
import { ref } from 'vue';
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui';

defineProps<{ align?: 'left' | 'right'; up?: boolean }>();
const open = ref(false);
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverTrigger as-child><slot name="trigger" :open="open" /></PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        :side="up ? 'top' : 'bottom'"
        :align="align === 'right' ? 'end' : 'start'"
        :side-offset="4"
        :collision-padding="8"
        class="z-30 max-h-[min(70vh,var(--reka-popover-content-available-height))] min-w-[220px] overflow-y-auto rounded-md border border-border bg-panel p-1.5 shadow-popover"
      >
        <slot :close="() => (open = false)" />
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
