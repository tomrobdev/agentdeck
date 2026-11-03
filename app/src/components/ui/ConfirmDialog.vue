<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import {
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle,
} from 'reka-ui';

// One confirm for every "are you sure": a title, a body, and a confirm and cancel button. Enter presses whichever button has
// focus, so `focus` is the Enter policy: "confirm" for a safe default, "cancel" for one that can't be undone (Close PR),
// "field" to start in the body's first text field. While `busy` the action runs, so nothing dismisses the dialog.
// Mount it with v-if; Cancel, Escape and a click outside emit `cancel`, the confirm button emits `confirm` and leaves the
// closing to the caller.
const props = withDefaults(
  defineProps<{
    title: string;
    confirmLabel: string;
    cancelLabel?: string;
    focus?: 'confirm' | 'cancel' | 'field';
    busy?: boolean;
    confirmDisabled?: boolean;
    hideCancel?: boolean;
  }>(),
  { cancelLabel: 'Cancel', focus: 'confirm' },
);
const emit = defineEmits<{ cancel: []; confirm: [] }>();

const content = ref<{ $el: HTMLElement } | null>(null);
const confirmButton = ref<HTMLElement | null>(null);

function focusTarget(): HTMLElement | null | undefined {
  const root = content.value?.$el;
  if (props.focus === 'field') return root?.querySelector<HTMLElement>('textarea, input, select') ?? confirmButton.value;
  if (props.focus === 'cancel') return root?.querySelector<HTMLElement>('[data-cancel]');
  return confirmButton.value;
}

function onOpenAutoFocus(e: Event) {
  e.preventDefault();
  focusTarget()?.focus();
}

// A button that was disabled when the dialog opened (a preview still loading) or while it worked loses focus: take it back
// once it is enabled, unless the person has moved on to something inside the dialog.
watch(
  () => [props.busy, props.confirmDisabled],
  async () => {
    await nextTick();
    const active = document.activeElement;
    if (!active || active === document.body) focusTarget()?.focus();
  },
);

function onEscape(e: KeyboardEvent) {
  // A confirm nested in another dialog: the Escape closes only this one.
  e.stopPropagation();
  if (props.busy) e.preventDefault();
}
const ignoreWhileBusy = (e: Event) => props.busy && e.preventDefault();
const onOpenChange = (open: boolean) => !open && !props.busy && emit('cancel');
</script>

<template>
  <AlertDialogRoot :open="true" @update:open="onOpenChange">
    <AlertDialogPortal>
      <AlertDialogOverlay class="fixed inset-0 z-20 bg-[rgb(0_0_0/0.35)]" />
      <div class="pointer-events-none fixed inset-0 z-20 grid place-items-center">
        <AlertDialogContent
          ref="content"
          class="pointer-events-auto max-h-[calc(100vh-64px)] w-[min(560px,calc(100vw-32px))] overflow-auto rounded-lg border border-border bg-panel px-5 pt-4 pb-5 shadow-modal"
          @open-auto-focus="onOpenAutoFocus"
          @escape-key-down="onEscape"
          @pointer-down-outside="ignoreWhileBusy"
          @interact-outside="ignoreWhileBusy"
        >
          <AlertDialogTitle class="m-0 mb-3 text-lg">{{ title }}</AlertDialogTitle>
          <AlertDialogDescription as="div"><slot /></AlertDialogDescription>
          <div class="mt-4 flex justify-end gap-2">
            <AlertDialogCancel v-if="!hideCancel" as-child>
              <button data-cancel :disabled="busy">{{ cancelLabel }}</button>
            </AlertDialogCancel>
            <button ref="confirmButton" class="primary" :disabled="busy || confirmDisabled" @click="emit('confirm')">
              {{ confirmLabel }}
            </button>
          </div>
        </AlertDialogContent>
      </div>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>
