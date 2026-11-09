// Single-key shortcuts. Each component lists its keys with a label and a scope; `hotkeyApplies` owns when a press counts and
// `resolveKey` what it means (a key, or the second key of a sequence such as `g q`). The keys bound are registered while the
// component is mounted, so the `?` sheet lists the keys in force (lib/hotkeys.ts).
import { onBeforeUnmount, onMounted } from 'vue';
import { hotkeyApplies } from '../../lib/shared/hotkey-applies';
import { type HotkeyDef, type HotkeyScope, type PendingKey, registerKeys, resolveKey } from '../../lib/shared/hotkeys';

export interface HotkeyBinding {
  label: string;
  scope: HotkeyScope;
  run: () => unknown;
}

export function useHotkeys(keys: Record<string, HotkeyBinding>): void {
  const bindings = Object.keys(keys);
  const defs: HotkeyDef[] = bindings.map((key) => ({ key, label: keys[key].label, scope: keys[key].scope }));
  let pending: PendingKey | null = null;
  let unregister = () => {};
  function onKey(e: KeyboardEvent) {
    if (!hotkeyApplies(e)) {
      pending = null;
      return;
    }
    const step = resolveKey(bindings, pending, e.key, Date.now());
    pending = step.pending;
    if (!step.match && !step.pending) return;
    e.preventDefault();
    if (step.match) keys[step.match].run();
  }
  onMounted(() => {
    unregister = registerKeys(defs);
    window.addEventListener('keydown', onKey);
  });
  onBeforeUnmount(() => {
    unregister();
    window.removeEventListener('keydown', onKey);
  });
}
