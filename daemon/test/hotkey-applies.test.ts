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

test('nothing counts while a menu or dialog is open', () => {
  page('[role="menu"]');
  assert.equal(hotkeyApplies(press('j', [])), false);
  page('[role="dialog"]');
  assert.equal(hotkeyApplies(press('j', [])), false);
});

test('typing in a field, or with a modifier, does not count', () => {
  page(null);
  assert.equal(hotkeyApplies(press('j', ['input'])), false);
  assert.equal(hotkeyApplies(press('j', [], { metaKey: true })), false);
  assert.equal(hotkeyApplies(press('j', [], { defaultPrevented: true })), false);
});
