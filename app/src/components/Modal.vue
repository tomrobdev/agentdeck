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
  <div class="fixed inset-0 z-10 grid place-items-center bg-[rgb(0_0_0/0.35)]" @click.self="$emit('close')">
    <div
      class="max-h-[calc(100vh-64px)] w-[min(560px,calc(100vw-32px))] overflow-auto rounded-lg border border-border bg-panel px-5 pt-4 pb-5 shadow-modal"
      role="dialog"
      :aria-label="title"
    >
      <header class="mb-3 flex items-center">
        <h3 class="m-0 flex-1 text-lg">{{ title }}</h3>
        <button class="border-0 bg-transparent text-muted" @click="$emit('close')" aria-label="Close">✕</button>
      </header>
      <slot />
    </div>
  </div>
</template>
