// The window's shell decisions: which panels there are, where a `g` key goes, and which key toggles the command palette.
import type { GoTarget } from '#lib/shared/hotkeys.ts';

export type Panel = 'new' | 'repos' | 'settings' | 'daemon';

export function goMove(to: GoTarget): { panel: Panel } | { page: 'queue' | 'insights' } {
  return to === 'settings' || to === 'repos' ? { panel: to } : { page: to };
}

export function isPaletteKey(e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'key'>): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k';
}
