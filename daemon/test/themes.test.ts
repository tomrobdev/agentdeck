// Every dashboard theme, in both modes, must pass WCAG AA (4.5:1 for text, 3:1 for control edges and icons).
// Reads app/src/styles/themes.css and checks the pairs the dashboard actually draws, including the tinted backgrounds.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

type Vars = Record<string, string>;
type Rgb = [number, number, number];

const css = readFileSync(new URL('../../app/src/styles/themes.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** `selector { --a: b; }` rules, with the `@media (prefers-color-scheme: dark)` ones tagged. */
function rules(source: string, media = false): { selector: string; vars: Vars; media: boolean }[] {
  const out: { selector: string; vars: Vars; media: boolean }[] = [];
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf('{', i);
    if (open < 0) break;
    const head = source.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (depth && j < source.length) ((depth += source[j] === '{' ? 1 : source[j] === '}' ? -1 : 0), j++);
    const body = source.slice(open + 1, j - 1);
    if (head.startsWith('@media')) out.push(...rules(body, head.includes('prefers-color-scheme: dark')));
    else
      out.push({
        selector: head,
        vars: Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()])),
        media,
      });
    i = j;
  }
  return out;
}

const parsed = rules(css);
const themes = [...new Set(parsed.flatMap((r) => [...r.selector.matchAll(/data-theme='([\w-]+)'\]/g)].map((m) => m[1])))];

function palette(theme: string, mode: 'light' | 'dark'): Vars {
  const hit = parsed.filter(
    (r) =>
      !r.media &&
      r.selector.split(',').some((s) => s.includes(`[data-theme='${theme}']`) && s.includes(`[data-mode='dark']`) === (mode === 'dark')),
  );
  assert.equal(hit.length, 1, `${theme} ${mode}: expected one rule`);
  return hit[0].vars;
}

function toRgb(hex: string): Rgb {
  assert.match(hex, /^#[0-9a-f]{6}$/i, `not a #rrggbb colour: ${hex}`);
  return [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16)) as Rgb;
}
const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
function ratio(a: Rgb, b: Rgb) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** `color-mix(in srgb, fg pct%, bg)`, which is how the dashboard tints. */
const mix = (fg: Rgb, pct: number, bg: Rgb): Rgb => fg.map((c, k) => c * (pct / 100) + bg[k] * (1 - pct / 100)) as Rgb;

const STATUS = ['queued', 'running', 'done', 'blocked', 'failed', 'cancelled', 'merged'];
const HL = ['keyword', 'string', 'number', 'comment', 'title', 'type', 'attr'].map((n) => `hl-${n}`);

function problems(p: Vars): string[] {
  const c = (name: string) => toRgb(p[`--${name}`] ?? assert.fail(`missing --${name}`));
  const found: string[] = [];
  const need = (what: string, fg: Rgb, bg: Rgb, min: number) => {
    const r = ratio(fg, bg);
    if (r < min) found.push(`${what}: ${r.toFixed(2)} < ${min}`);
  };
  const surfaces = ['panel', 'bg', 'panel-2'];
  const codeSurfaces = [...surfaces, 'code-bg'];

  for (const s of codeSurfaces) for (const t of ['text', 'muted']) need(`${t} on ${s}`, c(t), c(s), 4.5);
  for (const s of surfaces) need(`accent on ${s}`, c('accent'), c(s), 4.5);
  // Fields and checkboxes sit on cards and on the page, not on header strips.
  for (const s of ['panel', 'bg']) need(`border-input on ${s}`, c('border-input'), c(s), 3);
  need('accent-fg on accent', c('accent-fg'), c('accent'), 4.5);
  const soft = mix(c('accent'), 14, c('panel'));
  for (const t of ['text', 'muted', 'accent']) need(`${t} on the accent tint`, c(t), soft, 4.5);

  for (const name of ['accent', ...STATUS]) {
    for (const s of surfaces) if (name !== 'accent') need(`${name} on ${s}`, c(name), c(s), 4.5);
    // Pills tint their own colour over the page or a card: 14%, and 16% on the task page's header.
    need(`${name} pill on bg`, c(name), mix(c(name), 14, c('bg')), 4.5);
    need(`${name} pill on panel`, c(name), mix(c(name), 14, c('panel')), 4.5);
    need(`${name} task page pill`, c(name), mix(c(name), 16, c('panel')), 4.5);
  }

  // Code: the viewer, and the diff's tinted lines, gutters and highlighted line.
  const diff: [string, Rgb][] = [
    ['added line', mix(c('done'), 14, c('panel'))],
    ['removed line', mix(c('failed'), 13, c('panel'))],
    ['hunk header', mix(c('running'), 9, c('panel'))],
    ['highlighted line', mix(c('blocked'), 18, c('panel'))],
  ];
  const gutters: [string, Rgb][] = [
    ['added gutter', mix(c('done'), 22, c('panel'))],
    ['removed gutter', mix(c('failed'), 20, c('panel'))],
    ['highlighted gutter', mix(c('blocked'), 26, c('panel'))],
  ];
  for (const h of HL) {
    for (const s of codeSurfaces) need(`${h} on ${s}`, c(h), c(s), 4.5);
    for (const [name, bg] of diff) need(`${h} on ${name}`, c(h), bg, 4.5);
  }
  // The highlighted line's gutter and the code on it use --text; only the other tints carry --muted (line numbers, +/- signs).
  for (const [name, bg] of [...diff, ...gutters]) {
    need(`text on ${name}`, c('text'), bg, 4.5);
    if (!name.startsWith('highlighted')) need(`muted on ${name}`, c('muted'), bg, 4.5);
  }
  return found;
}

test('there are at least three themes, and the default is high contrast', () => {
  assert.ok(themes.length >= 3 && themes.length <= 4, themes.join());
  assert.ok(themes.includes('contrast'));
  assert.match(css, /:root,\s*:root\[data-theme='contrast'\]/);
});

test('every theme defines the same tokens in light and dark', () => {
  const keys = Object.keys(palette('warm', 'light')).sort();
  for (const t of themes)
    for (const m of ['light', 'dark'] as const) assert.deepEqual(Object.keys(palette(t, m)).sort(), keys, `${t} ${m}`);
});

test('the system mode repeats the dark palette under prefers-color-scheme', () => {
  for (const t of themes) {
    const media = parsed.filter((r) => r.media && r.selector.includes(`[data-theme='${t}']`));
    assert.equal(media.length, 1, t);
    assert.deepEqual(media[0].vars, palette(t, 'dark'), `${t}: system dark differs from dark`);
  }
});

for (const t of themes) {
  for (const m of ['light', 'dark'] as const) {
    test(`${t} ${m} passes WCAG AA`, () => {
      const found = problems(palette(t, m));
      assert.equal(found.length, 0, `${t} ${m}: ${found.join('; ')}`);
    });
  }
}
