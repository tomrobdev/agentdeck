<script setup lang="ts">
import { DropdownMenuPortal, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from 'reka-ui';
import { MENU_CONTENT, MENU_ITEM } from './menu';

// A submenu: ArrowRight or a hover on its row opens it, ArrowLeft or Escape closes it. `opened` fires once it is open and has
// taken its focus, for a submenu whose first stop is an input (that input should `@keydown.stop`, so the menu's typeahead and
// arrow keys don't take its keys).
defineProps<{ label: string; disabled?: boolean }>();
const emit = defineEmits<{ opened: [] }>();
// Reka focuses the content itself right after this event, so wait a tick for the caller's focus to be the last word.
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
