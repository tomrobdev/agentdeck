// The window's shared state: the open panel, the command palette, the key sheet and the task being merged. Module refs, as
// useView.ts keeps the palette's requests, so any component opens a panel itself instead of emitting up to App.
import { ref } from 'vue';
import { type Panel, goMove } from '../../lib/shared/shell';
import type { GoTarget } from '../../lib/shared/hotkeys';
import { type Route, go } from '../../router';

/** The panel open over the page, if any. */
export const panel = ref<Panel | null>(null);
/** True while the command palette is open. */
export const palette = ref(false);
/** True while the sheet of keys is open. */
export const keySheet = ref(false);
/** The task the merge dialog is open for. */
export const merging = ref<number | null>(null);

export const openPanel = (p: Panel) => (panel.value = p);
export const closePanel = () => (panel.value = null);
/** Go to a page, closing any panel. */
export function goPage(to: Route) {
  panel.value = null;
  go(to);
}
/** `g` then a key, and the palette's go commands: the queue and insights are pages, settings and repos panels. */
export function goTo(to: GoTarget) {
  const move = goMove(to);
  if ('panel' in move) openPanel(move.panel);
  else goPage({ name: move.page });
}
export const startMerge = (id: number) => (merging.value = id);
export const togglePalette = () => (palette.value = !palette.value);
export const closePalette = () => (palette.value = false);
export const showKeys = () => (keySheet.value = true);
export const closeKeys = () => (keySheet.value = false);

export function useShell() {
  return {
    panel,
    palette,
    keySheet,
    merging,
    openPanel,
    closePanel,
    goPage,
    goTo,
    startMerge,
    togglePalette,
    closePalette,
    showKeys,
    closeKeys,
  };
}
