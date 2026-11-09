// The window's shell decisions: which panels there are, where a `g` key goes, and which key toggles the command palette.
// Pure, so the daemon's tests can import it (daemon/test/dashboard/shared/shell.test.ts).
import type { GoTarget } from './hotkeys.ts';

/** The panels a window opens over its page, one at a time. */
export type Panel = 'new' | 'repos' | 'settings' | 'daemon';

/** Where a go target leads: settings and repos are panels over the page, the queue and insights are pages. */
export function goMove(to: GoTarget): { panel: Panel } | { page: 'queue' | 'insights' } {
  return to === 'settings' || to === 'repos' ? { panel: to } : { page: to };
}

/** True for ⌘K (or Ctrl+K) with no other modifier: the browser's key for the command palette. */
export function isPaletteKey(e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'key'>): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k';
}
