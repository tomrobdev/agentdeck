<script setup lang="ts">
import { computed, ref } from 'vue';
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';

type ModalSize = 'md' | 'lg' | 'xl';

const props = withDefaults(
  defineProps<{
    title: string;
    focus?: string | HTMLElement | null;
    size?: ModalSize;
    scroll?: boolean;
  }>(),
  { focus: null, size: 'md', scroll: true },
);
const emit = defineEmits<{ close: [] }>();

const WIDTH: Record<ModalSize, string> = {
  md: 'w-[min(560px,calc(100vw-32px))] max-h-[calc(100vh-64px)]',
  lg: 'w-[min(880px,calc(100vw-32px))] h-[min(820px,calc(100vh-64px))]',
  xl: 'w-[min(1040px,calc(100vw-32px))] h-[min(820px,calc(100vh-64px))]',
};
const sizeClass = computed(() => WIDTH[props.size]);

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
        class="fixed top-1/2 left-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-panel shadow-modal"
        :class="sizeClass"
        aria-modal="true"
        :aria-describedby="undefined"
        @open-auto-focus="onOpenAutoFocus"
      >
        <header class="flex flex-none items-center border-b border-border px-6 py-3">
          <DialogTitle class="m-0 flex-1 text-lg font-semibold">{{ title }}</DialogTitle>
          <button class="border-0 bg-transparent text-muted" aria-label="Close" @click="emit('close')">✕</button>
        </header>
        <div :class="scroll ? 'pane-body' : 'flex min-h-0 flex-1 flex-col'" data-modal-body>
          <slot />
        </div>
        <footer v-if="$slots.footer" class="pane-footer">
          <slot name="footer" />
        </footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
