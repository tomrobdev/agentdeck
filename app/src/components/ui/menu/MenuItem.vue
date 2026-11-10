<script setup lang="ts">
import { DropdownMenuItem } from 'reka-ui';
import { MENU_ITEM } from './menu';

defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ select: [event: Event] }>();
</script>

<template>
  <DropdownMenuItem :class="MENU_ITEM" :disabled="disabled" @select="emit('select', $event)"><slot /></DropdownMenuItem>
</template>
