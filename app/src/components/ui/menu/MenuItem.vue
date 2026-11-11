<script setup lang="ts">
import { DropdownMenuItem } from 'reka-ui';
import { MENU_ITEM } from '#components/ui/menu/menu.ts';

defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ select: [event: Event] }>();
</script>

<template>
  <DropdownMenuItem :class="MENU_ITEM" :disabled="disabled" @select="emit('select', $event)"><slot /></DropdownMenuItem>
</template>
