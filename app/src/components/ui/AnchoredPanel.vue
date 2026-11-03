<script setup lang="ts">
import { PopoverAnchor, PopoverContent, PopoverPortal, PopoverRoot } from 'reka-ui';

// A panel shown beside something the caller points at (`anchor`: an element, or anything with getBoundingClientRect), with
// no trigger of its own: the caller says when it is `open`. It flips to the other side and shifts to stay on screen. It
// takes no focus and no pointer events, so it can sit under the pointer; Escape and a press outside ask to close it.
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
