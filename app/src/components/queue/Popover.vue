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
defineExpose({ close: () => (open.value = false) });
</script>

<template>
  <div ref="root" class="pop">
    <span @click="open = !open"><slot name="trigger" :open="open" /></span>
    <div v-if="open" class="panel" :class="align ?? 'left'" role="menu"><slot /></div>
  </div>
</template>

<style scoped>
.pop {
  position: relative;
}
.panel {
  position: absolute;
  top: calc(100% + 4px);
  z-index: 20;
  min-width: 220px;
  max-height: 70vh;
  overflow-y: auto;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 28px rgb(0 0 0 / 0.18);
  padding: 6px;
}
.panel.left {
  left: 0;
}
.panel.right {
  right: 0;
}
</style>
