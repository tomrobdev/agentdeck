<script setup lang="ts">
import { DropdownMenuItem } from 'reka-ui';
import { MENU_ITEM } from './menu';

// One action in a Menu. `select` fires on a click or Enter, and the menu closes after it (call `event.preventDefault()` to keep it open).
defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ select: [event: Event] }>();
</script>

<template>
  <DropdownMenuItem :class="MENU_ITEM" :disabled="disabled" @select="emit('select', $event)"><slot /></DropdownMenuItem>
</template>
