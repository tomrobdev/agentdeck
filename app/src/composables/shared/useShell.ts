import { ref } from 'vue';
import { type RouteLocationRaw, useRouter } from 'vue-router';
import { type Panel, goMove } from '../../lib/shared/shell';
import type { GoTarget } from '../../lib/shared/hotkeys';

export const panel = ref<Panel | null>(null);
export const palette = ref(false);
export const keySheet = ref(false);
export const selectedId = ref<number | null>(null);
export const merging = ref<number | null>(null);

export const openPanel = (p: Panel) => (panel.value = p);
export const closePanel = () => (panel.value = null);
export const startMerge = (id: number) => (merging.value = id);
export const togglePalette = () => (palette.value = !palette.value);
export const closePalette = () => (palette.value = false);
export const showKeys = () => (keySheet.value = true);
export const closeKeys = () => (keySheet.value = false);

export function useShell() {
  const router = useRouter();
  function goPage(to: RouteLocationRaw) {
    panel.value = null;
    void router.push(to);
  }
  function goTo(to: GoTarget) {
    const move = goMove(to);
    if ('panel' in move) openPanel(move.panel);
    else goPage({ name: move.page });
  }
  return {
    panel,
    palette,
    keySheet,
    selectedId,
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
