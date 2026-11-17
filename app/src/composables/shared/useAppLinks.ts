// The window's ways in from outside the page: the app's keys (`g` then a key, `?`), the browser's ⌘K, and agentdeck:// links.
import { onBeforeUnmount, onMounted } from 'vue';
import { type Router, useRouter } from 'vue-router';
import { GO_KEYS } from '#lib/shared/hotkeys.ts';
import { isPaletteKey } from '#lib/shared/shell.ts';
import { isNative, onOpenUrl } from '#platform/native.ts';
import { parseAppUrl } from '#lib/shared/app-url.ts';
import { useHotkeys } from '#composables/shared/useHotkeys.ts';
import { closePanel, openPanel, showKeys, togglePalette, useShell } from '#composables/shared/useShell.ts';

function openLink(url: string, router: Router) {
  const to = parseAppUrl(url);
  if (!to) return;
  if (to.name === 'palette') togglePalette();
  else if (to.name === 'new') openPanel('new');
  else if (to.name === 'panel') openPanel(to.panel);
  else {
    closePanel();
    void router.push(to);
  }
}

function onPaletteKey(e: KeyboardEvent) {
  if (isNative || !isPaletteKey(e)) return;
  e.preventDefault();
  togglePalette();
}

export function useAppLinks() {
  const router = useRouter();
  const { goTo } = useShell();
  useHotkeys({
    ...Object.fromEntries(GO_KEYS.map((g) => [g.key, { label: g.label, scope: 'app' as const, run: () => goTo(g.to) }])),
    '?': { label: 'Show the keys', scope: 'app', run: showKeys },
  });

  let stopOpenUrl = () => {};
  let unmounted = false;
  onMounted(() => {
    window.addEventListener('keydown', onPaletteKey);
    onOpenUrl((url) => openLink(url, router)).then((stop) => (unmounted ? stop() : (stopOpenUrl = stop)));
  });
  onBeforeUnmount(() => {
    unmounted = true;
    stopOpenUrl();
    window.removeEventListener('keydown', onPaletteKey);
  });
}
