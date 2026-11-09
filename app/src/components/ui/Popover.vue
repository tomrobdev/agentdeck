<script setup lang="ts">
import { ref } from 'vue';
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui';

// A panel anchored to its trigger. It flips to the other side and shifts to stay on screen, closes on an outside click or
// Escape, and the trigger carries aria-expanded. The default slot gets `close` for content that should dismiss it (a chosen row).
// Non-modal: single-key hotkeys stay live under it (lib/shared/hotkey-applies.ts).
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
