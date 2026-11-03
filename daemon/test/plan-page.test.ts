import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withBaseStyle } from '../../app/src/lib/planPage.ts';

const CSS = '.plan { color: red; }';

test('a plan without plan.css gets the base style first in head, following the mode', () => {
  const page = '<!doctype html><html><head><title>t</title></head><body>x</body></html>';
  const dark = withBaseStyle(page, 'dark', CSS);
  assert.match(dark, /<head><style>\n:root \{ color-scheme: dark; \}/);
  assert.ok(dark.includes('<title>t</title>'));
  assert.ok(!dark.includes(CSS));
  assert.match(withBaseStyle(page, 'system', CSS), /color-scheme: light dark;/);
});

test('a plan linking plan.css gets the css in place of the link and always renders light', () => {
  const page = '<html><head><link rel="stylesheet" href="plan.css" /></head><body></body></html>';
  const out = withBaseStyle(page, 'dark', CSS);
  assert.ok(out.includes(`<style>${CSS}</style>`));
  assert.ok(!out.includes('plan.css'));
  assert.match(out, /color-scheme: light;/);
  assert.ok(out.indexOf('color-scheme') < out.indexOf(CSS));
});

test('the css is put in verbatim, whatever $ it holds', () => {
  const css = 'a::after { content: "$&"; }';
  assert.ok(withBaseStyle('<head><link href="plan.css"></head>', 'light', css).includes(css));
});

test('a page without head gets the style after its doctype, or at the start', () => {
  assert.match(withBaseStyle('<!DOCTYPE html><p>hi</p>', 'light', CSS), /^<!DOCTYPE html><style>/);
  assert.match(withBaseStyle('<p>hi</p>', 'light', CSS), /^<style>/);
});
