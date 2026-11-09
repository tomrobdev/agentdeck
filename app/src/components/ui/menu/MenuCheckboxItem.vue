<script setup lang="ts">
import { DropdownMenuCheckboxItem, DropdownMenuItemIndicator } from 'reka-ui';
import { MENU_ITEM } from './menu';

// A menu item that is on or off. The menu stays open, so several can be ticked in a row.
const checked = defineModel<boolean>('checked', { default: false });
</script>

<template>
  <DropdownMenuCheckboxItem v-model="checked" :class="[MENU_ITEM, 'justify-start']" @select.prevent>
    <span class="w-3 flex-none text-accent"><DropdownMenuItemIndicator>✓</DropdownMenuItemIndicator></span>
    <slot />
  </DropdownMenuCheckboxItem>
</template>
