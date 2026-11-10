<script setup lang="ts">
import { DropdownMenuPortal, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from 'reka-ui';
import { MENU_CONTENT, MENU_ITEM } from './menu';

defineProps<{ label: string; disabled?: boolean }>();
const emit = defineEmits<{ opened: [] }>();
const afterFocus = () => void setTimeout(() => emit('opened'));
</script>

<template>
  <DropdownMenuSub>
    <DropdownMenuSubTrigger :class="MENU_ITEM" :disabled="disabled"> {{ label }} <span aria-hidden="true">▸</span> </DropdownMenuSubTrigger>
    <DropdownMenuPortal>
      <DropdownMenuSubContent :side-offset="4" :collision-padding="8" :class="MENU_CONTENT" @open-auto-focus="afterFocus">
        <slot />
      </DropdownMenuSubContent>
    </DropdownMenuPortal>
  </DropdownMenuSub>
</template>
