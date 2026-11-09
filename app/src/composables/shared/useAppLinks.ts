// The window's ways in from outside the page: the app's keys (`g` then a key, `?`), the browser's ⌘K, and agentdeck:// links.
import { onBeforeUnmount, onMounted } from 'vue';
import { GO_KEYS } from '../../lib/shared/hotkeys';
import { isPaletteKey } from '../../lib/shared/shell';
import { isNative, onOpenUrl } from '../../platform/native';
import { parseAppUrl } from '../../router';
import { useHotkeys } from './useHotkeys';
import { goPage, goTo, openPanel, showKeys, togglePalette } from './useShell';

/** An agentdeck:// link opened from outside (the shell's open_in_dashboard): a page, a panel or the palette. */
function openLink(url: string) {
  const to = parseAppUrl(url);
  if (!to) return;
  if (to.name === 'palette') togglePalette();
  else if (to.name === 'new') openPanel('new');
  else if (to.name === 'panel') openPanel(to.panel);
  else goPage(to);
}

// In the desktop app the View menu owns ⌘K (it arrives as agentdeck://palette); this handler is for the plain browser.
function onPaletteKey(e: KeyboardEvent) {
  if (isNative || !isPaletteKey(e)) return;
  e.preventDefault();
  togglePalette();
}

/** Registers the app's keys and listens for ⌘K and agentdeck:// links while the component is mounted. */
export function useAppLinks() {
  useHotkeys({
    ...Object.fromEntries(GO_KEYS.map((g) => [g.key, { label: g.label, scope: 'app' as const, run: () => goTo(g.to) }])),
    '?': { label: 'Show the keys', scope: 'app', run: showKeys },
  });

  let stopOpenUrl = () => {};
  let unmounted = false;
  onMounted(() => {
    window.addEventListener('keydown', onPaletteKey);
    onOpenUrl(openLink).then((stop) => (unmounted ? stop() : (stopOpenUrl = stop)));
  });
  onBeforeUnmount(() => {
    unmounted = true;
    stopOpenUrl();
    window.removeEventListener('keydown', onPaletteKey);
  });
}
