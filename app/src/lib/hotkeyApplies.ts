// Whether a single-key shortcut counts for this key press. Pure apart from reading the page for an open dialog or menu.
// Not while typing in a field, not with a modifier down, not while a dialog or menu is open, and Enter and Space
// belong to a focused button or link (they activate it).
const FIELD = 'input, textarea, select, [contenteditable]';
const ACTIVATABLE = 'button, a, [role="button"]';
// A layer that takes the keyboard: a modal dialog (ui/Modal marks its content aria-modal), an alert dialog, a menu or a
// listbox. A non-modal popover is a role="dialog" without aria-modal, so single keys still work under it.
const BLOCKING_LAYER = '[role="dialog"][aria-modal="true"], [role="alertdialog"], [role="menu"], [role="listbox"]';

export function hotkeyApplies(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return false;
  // Element, not HTMLElement: SVG nodes (the graph) count too.
  const target = e.target instanceof Element ? e.target : null;
  if (target?.closest(FIELD)) return false;
  if (document.querySelector(BLOCKING_LAYER)) return false;
  if ((e.key === 'Enter' || e.key === ' ') && target?.closest(ACTIVATABLE)) return false;
  return true;
}
