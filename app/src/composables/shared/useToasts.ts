import { ref } from 'vue';
import { type Flash, UNDO_MS } from '#composables/shared/useActions.ts';

export interface ToastItem {
  id: number;
  message: string;
  duration: number;
  action?: { label: string; run: () => void };
}

export const toastDuration = (message: string) => Math.min(Math.max(3500, message.length * 60), 15_000);

const toasts = ref<ToastItem[]>([]);
let lastId = 0;
const flash: Flash = (message, action) => {
  toasts.value = [...toasts.value, { id: ++lastId, message, duration: action ? UNDO_MS : toastDuration(message), action }];
};
const close = (id: number) => {
  toasts.value = toasts.value.filter((t) => t.id !== id);
};

export function useToasts() {
  return { toasts, flash, close };
}
