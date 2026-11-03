// When a single-key shortcut counts. The dashboard has no test runner and no DOM, so the page is faked here.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { hotkeyApplies } from '../../app/src/lib/hotkeyApplies.ts';

class FakeElement {
  readonly matches: string[];
  constructor(matches: string[]) {
    this.matches = matches;
  }
  closest(selector: string) {
    return selector.split(',').some((s) => this.matches.includes(s.trim())) ? this : null;
  }
}

const g = globalThis as unknown as Record<string, unknown>;
g.Element = FakeElement;
const page = (open: string | null) => {
  g.document = { querySelector: (sel: string) => (open && sel.includes(open) ? {} : null) };
};
afterEach(() => page(null));

const press = (key: string, target: string[] | null, extra: Record<string, unknown> = {}) =>
  ({
    key,
    target: target && new FakeElement(target),
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...extra,
  }) as never;

test('Enter and Space on a button, link or role=button are left to it', () => {
  page(null);
  assert.equal(hotkeyApplies(press('Enter', ['button'])), false);
  assert.equal(hotkeyApplies(press(' ', ['a'])), false);
  assert.equal(hotkeyApplies(press('Enter', ['[role="button"]'])), false);
});

test('other keys still work on a focused button', () => {
  page(null);
  assert.equal(hotkeyApplies(press('j', ['button'])), true);
  assert.equal(hotkeyApplies(press('Enter', [])), true);
});

test('nothing counts while a modal dialog, alert dialog, menu or listbox is open', () => {
  for (const layer of ['[role="dialog"][aria-modal="true"]', '[role="alertdialog"]', '[role="menu"]', '[role="listbox"]']) {
    page(layer);
    assert.equal(hotkeyApplies(press('j', [])), false, layer);
  }
});

test('a non-modal popover (a dialog role without aria-modal) leaves the keys on', () => {
  page('[role="dialog"]:not([aria-modal])');
  assert.equal(hotkeyApplies(press('j', [])), true);
});

test('typing in a field, or with a modifier, does not count', () => {
  page(null);
  assert.equal(hotkeyApplies(press('j', ['input'])), false);
  assert.equal(hotkeyApplies(press('j', [], { metaKey: true })), false);
  assert.equal(hotkeyApplies(press('j', [], { defaultPrevented: true })), false);
});
