// Whether a single-key shortcut counts for this key press. Pure apart from reading the page for an open dialog or menu.
const FIELD = 'input, textarea, select, [contenteditable]';
const ACTIVATABLE = 'button, a, [role="button"]';
const BLOCKING_LAYER = [
  '[role="dialog"][aria-modal="true"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="dialog"] [role="listbox"]',
  '[role="combobox"][aria-expanded="true"]',
].join(', ');

export function hotkeyApplies(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return false;
  const target = e.target instanceof Element ? e.target : null;
  if (target?.closest(FIELD)) return false;
  if (document.querySelector(BLOCKING_LAYER)) return false;
  if ((e.key === 'Enter' || e.key === ' ') && target?.closest(ACTIVATABLE)) return false;
  return true;
}
