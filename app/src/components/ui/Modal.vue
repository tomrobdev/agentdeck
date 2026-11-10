<script setup lang="ts">
import { ref } from 'vue';
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';

const props = defineProps<{
  title: string;
  focus?: string | HTMLElement | null;
}>();
const emit = defineEmits<{ close: [] }>();

const content = ref<{ $el: HTMLElement } | null>(null);
const FIELD = 'input:not([type="hidden"]), textarea, select, [contenteditable]';

function onOpenAutoFocus(e: Event) {
  const root = content.value?.$el;
  const target = typeof props.focus === 'string' ? root?.querySelector<HTMLElement>(props.focus) : props.focus;
  const field = target ?? root?.querySelector<HTMLElement>(`[data-modal-body] :is(${FIELD})`);
  if (!field) return;
  e.preventDefault();
  field.focus();
}
</script>

<template>
  <DialogRoot :open="true" @update:open="(open) => !open && emit('close')">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-10 bg-[rgb(0_0_0/0.35)]" />
      <DialogContent
        ref="content"
        class="fixed top-1/2 left-1/2 z-10 max-h-[calc(100vh-64px)] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border border-border bg-panel px-5 pt-4 pb-5 shadow-modal"
        aria-modal="true"
        :aria-describedby="undefined"
        @open-auto-focus="onOpenAutoFocus"
      >
        <header class="mb-3 flex items-center">
          <DialogTitle class="m-0 flex-1 text-lg font-semibold">{{ title }}</DialogTitle>
          <button class="border-0 bg-transparent text-muted" aria-label="Close" @click="emit('close')">✕</button>
        </header>
        <div class="contents" data-modal-body>
          <slot />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
