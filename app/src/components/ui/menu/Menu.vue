<script setup lang="ts">
import { DropdownMenuContent, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from 'reka-ui';
import { MENU_CONTENT } from './menu';

const props = defineProps<{ label: string; at?: { x: number; y: number }; align?: 'left' | 'right' }>();
const open = defineModel<boolean>('open', { default: false });

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
