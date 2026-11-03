<script setup lang="ts">
import { ToastClose, ToastDescription, ToastProvider, ToastRoot, ToastViewport } from 'reka-ui';

// The one message at the bottom of the window. `id` changes with each message, so a newer one replaces the old and restarts
// the timer. It is announced to screen readers, paused while the pointer is over it, and closed by ✕, a swipe or Escape
// (F8 focuses it). `duration` is how long it stays, in ms.
defineProps<{ toast: { id: number; message: string; duration: number } | null }>();
const emit = defineEmits<{ close: [id: number] }>();
</script>

<template>
  <ToastProvider :duration="15000">
    <ToastRoot
      v-if="toast"
      :key="toast.id"
      :open="true"
      :duration="toast.duration"
      class="flex items-start gap-3 rounded-md bg-text px-3.5 py-2 text-bg"
      @update:open="(o) => !o && emit('close', toast!.id)"
    >
      <ToastDescription class="min-w-0 flex-1">{{ toast.message }}</ToastDescription>
      <ToastClose aria-label="Dismiss" class="flex-none border-0 bg-transparent p-0 text-bg opacity-70 hover:opacity-100">✕</ToastClose>
    </ToastRoot>
    <ToastViewport
      class="fixed bottom-10 left-1/2 z-40 m-0 flex w-max max-w-[calc(100vw-32px)] -translate-x-1/2 list-none flex-col gap-2 p-0 outline-none"
    />
  </ToastProvider>
</template>
