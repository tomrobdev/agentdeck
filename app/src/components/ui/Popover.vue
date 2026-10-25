<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

// A menu anchored under its trigger. Closes on an outside click or Escape.
defineProps<{ align?: 'left' | 'right' }>();
const open = ref(false);
const root = ref<HTMLElement | null>(null);

function onDoc(e: MouseEvent) {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false;
}
function onKey(e: KeyboardEvent) {
  if (open.value && e.key === 'Escape') {
    e.stopPropagation();
    open.value = false;
  }
}
onMounted(() => {
  document.addEventListener('mousedown', onDoc);
  document.addEventListener('keydown', onKey, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDoc);
  document.removeEventListener('keydown', onKey, true);
});
</script>

<template>
  <div ref="root" class="relative">
    <span @click="open = !open"><slot name="trigger" :open="open" /></span>
    <div
      v-if="open"
      class="absolute top-[calc(100%+4px)] z-20 max-h-[70vh] min-w-[220px] overflow-y-auto rounded-md border border-border bg-panel p-1.5 shadow-popover"
      :class="align === 'right' ? 'right-0' : 'left-0'"
      role="menu"
    >
      <slot />
    </div>
  </div>
</template>
