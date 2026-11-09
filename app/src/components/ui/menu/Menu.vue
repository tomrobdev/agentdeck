<script setup lang="ts">
import { DropdownMenuContent, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from 'reka-ui';
import { MENU_CONTENT } from './menu';

// A dropdown menu: arrow keys, typeahead, submenus, Escape and an outside click, all from Reka. The `trigger` slot is the
// button that opens it (it gets aria-expanded and gets focus back on close). Without one, `at` is a point on the page the
// menu opens at, for a right-click or the context-menu key; it flips and shifts to stay on screen. Open it with `v-model:open`.
// Modal: single-key hotkeys are off while it is open (lib/hotkeyApplies.ts finds it by role="menu").
const props = defineProps<{ label: string; at?: { x: number; y: number }; align?: 'left' | 'right' }>();
const open = defineModel<boolean>('open', { default: false });

// A menu opened at a point has no trigger to give focus back to, and what it opened (a dialog) wants the focus.
const keepFocus = (e: Event) => props.at && e.preventDefault();
</script>

<template>
  <DropdownMenuRoot v-model:open="open">
    <DropdownMenuTrigger v-if="$slots.trigger" as-child><slot name="trigger" :open="open" /></DropdownMenuTrigger>
    <DropdownMenuTrigger
      v-else-if="at"
      as="span"
      class="pointer-events-none fixed size-0"
      :style="{ left: `${at.x}px`, top: `${at.y}px` }"
    />
    <DropdownMenuPortal>
      <DropdownMenuContent
        :aria-label="label"
        :side-offset="4"
        :collision-padding="8"
        :align="align === 'right' ? 'end' : 'start'"
        :class="[MENU_CONTENT, 'min-w-[220px]']"
        @close-auto-focus="keepFocus"
      >
        <slot :close="() => (open = false)" />
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
