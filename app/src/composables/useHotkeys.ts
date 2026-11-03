// Single-key shortcuts. Each component lists its keys; `hotkeyApplies` owns when a key counts.
import { onBeforeUnmount, onMounted } from 'vue';
import { hotkeyApplies } from '../lib/hotkeyApplies';

export function useHotkeys(keys: Record<string, () => unknown>): void {
  function onKey(e: KeyboardEvent) {
    if (!hotkeyApplies(e)) return;
    const fn = keys[e.key];
    if (!fn) return;
    e.preventDefault();
    fn();
  }
  onMounted(() => window.addEventListener('keydown', onKey));
  onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
}
