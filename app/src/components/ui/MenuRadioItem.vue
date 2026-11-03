<script setup lang="ts">
import { DropdownMenuItemIndicator, DropdownMenuRadioItem } from 'reka-ui';
import { MENU_ITEM } from './menu';

// One choice in a MenuRadioGroup. The menu closes after a pick unless `keepOpen`.
const props = defineProps<{ value: string; keepOpen?: boolean }>();
const stay = (e: Event) => props.keepOpen && e.preventDefault();
</script>

<template>
  <DropdownMenuRadioItem :value="value" :class="[MENU_ITEM, 'justify-start']" @select="stay">
    <span class="w-3 flex-none text-accent"><DropdownMenuItemIndicator>✓</DropdownMenuItemIndicator></span>
    <slot />
  </DropdownMenuRadioItem>
</template>
