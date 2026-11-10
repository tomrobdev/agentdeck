<script setup lang="ts">
import { PopoverAnchor, PopoverContent, PopoverPortal, PopoverRoot } from 'reka-ui';

defineProps<{ open: boolean; anchor: { getBoundingClientRect(): DOMRect } | null }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <PopoverRoot :open="open && !!anchor" @update:open="(v) => !v && emit('close')">
    <PopoverAnchor v-if="anchor" :reference="anchor" />
    <PopoverPortal>
      <PopoverContent
        side="bottom"
        align="start"
        :side-offset="6"
        :collision-padding="8"
        :avoid-collisions="true"
        class="pointer-events-none z-30 w-[550px] max-w-[calc(100vw-16px)] overflow-hidden rounded-md border border-border bg-panel shadow-popover"
        @open-auto-focus.prevent
        @close-auto-focus.prevent
      >
        <slot />
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
