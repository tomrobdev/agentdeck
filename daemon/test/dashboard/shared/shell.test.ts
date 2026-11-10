// The shell's decisions: where a go target leads, and which key opens the command palette (app/src/lib/shared/shell.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GO_KEYS } from '../../../../app/src/lib/shared/hotkeys.ts';
import { goMove, isPaletteKey } from '../../../../app/src/lib/shared/shell.ts';

test('settings and repos open their panels; the queue and insights are pages', () => {
  assert.deepEqual(goMove('settings'), { panel: 'settings' });
  assert.deepEqual(goMove('repos'), { panel: 'repos' });
  assert.deepEqual(goMove('queue'), { page: 'queue' });
  assert.deepEqual(goMove('insights'), { page: 'insights' });
  for (const g of GO_KEYS) assert.ok(goMove(g.to));
});

const key = (k: Partial<Parameters<typeof isPaletteKey>[0]>) => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  key: 'k',
  ...k,
});

test('⌘K and Ctrl+K open the palette, in either case', () => {
  assert.equal(isPaletteKey(key({ metaKey: true })), true);
  assert.equal(isPaletteKey(key({ ctrlKey: true })), true);
  assert.equal(isPaletteKey(key({ metaKey: true, key: 'K' })), true);
});

test('K alone, another modifier, or another key is not the palette', () => {
  assert.equal(isPaletteKey(key({})), false);
  assert.equal(isPaletteKey(key({ metaKey: true, shiftKey: true })), false);
  assert.equal(isPaletteKey(key({ metaKey: true, altKey: true })), false);
  assert.equal(isPaletteKey(key({ metaKey: true, key: 'j' })), false);
});
