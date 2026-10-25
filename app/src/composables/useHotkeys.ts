// Single-key shortcuts. Each component lists its keys; this owns when a key counts: not while typing
// in a field, not with a modifier held, and not while a dialog is open over the page.
import { onBeforeUnmount, onMounted } from 'vue';

const isTyping = (e: KeyboardEvent) => e.target instanceof HTMLElement && !!e.target.closest('input, textarea, select, [contenteditable]');

export function useHotkeys(keys: Record<string, () => unknown>): void {
  function onKey(e: KeyboardEvent) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e)) return;
    if (document.querySelector('[role="dialog"]')) return;
    const fn = keys[e.key];
    if (!fn) return;
    e.preventDefault();
    fn();
  }
  onMounted(() => window.addEventListener('keydown', onKey));
  onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
}
