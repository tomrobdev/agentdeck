// The messages at the bottom of the window (Toaster.vue shows them). They live in App, so a page change keeps an Undo's wait going.
import { ref } from 'vue';
import { type Flash, UNDO_MS } from './useActions';

export interface ToastItem {
  id: number;
  message: string;
  /** How long it stays, in ms. */
  duration: number;
  /** A button on the toast (Undo): pressing it runs it and closes the toast. */
  action?: { label: string; run: () => void };
}

/** How long a message stays: long enough to read a long one (a gh error, a sync that could not push), at most 15 s. */
export const toastDuration = (message: string) => Math.min(Math.max(3500, message.length * 60), 15_000);

export function useToasts() {
  const toasts = ref<ToastItem[]>([]);
  let lastId = 0;
  // Messages stack: a newer one does not replace an Undo toast.
  const flash: Flash = (message, action) => {
    toasts.value = [...toasts.value, { id: ++lastId, message, duration: action ? UNDO_MS : toastDuration(message), action }];
  };
  const close = (id: number) => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  };
  return { toasts, flash, close };
}
