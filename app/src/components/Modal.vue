<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';

defineProps<{ title: string }>();
const emit = defineEmits<{ close: [] }>();

const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape') emit('close');
};
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="backdrop" @click.self="$emit('close')">
    <div class="modal" role="dialog" :aria-label="title">
      <header>
        <h3>{{ title }}</h3>
        <button class="x" @click="$emit('close')" aria-label="Close">✕</button>
      </header>
      <slot />
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 0.35);
  display: grid;
  place-items: center;
  z-index: 10;
}
.modal {
  width: min(560px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  overflow: auto;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px 20px 20px;
  box-shadow: 0 20px 60px rgb(0 0 0 / 0.25);
}
header {
  display: flex;
  align-items: center;
  margin-bottom: 12px;
}
h3 {
  margin: 0;
  font-size: 15px;
  flex: 1;
}
.x {
  border: none;
  background: none;
  color: var(--muted);
}
</style>
