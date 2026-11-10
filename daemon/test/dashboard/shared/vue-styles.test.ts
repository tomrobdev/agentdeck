// Scoped-style traps in the dashboard's .vue files that compile without error but break every page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const APP = join(ROOT, 'app', 'src');

function vueFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? vueFiles(join(dir, e.name)) : e.name.endsWith('.vue') ? [join(dir, e.name)] : [],
  );
}

test('no scoped style puts selectors after :global(…)', () => {
  const found: string[] = [];
  for (const file of vueFiles(APP)) {
    const text = readFileSync(file, 'utf8');
    for (const style of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) {
      const before = text.slice(0, style.index + style[0].indexOf(style[1]));
      for (const m of style[1].matchAll(/:global\([^)]*\)\s*[^\s{,]/g)) {
        const line = before.split('\n').length + style[1].slice(0, m.index).split('\n').length - 1;
        found.push(`${relative(ROOT, file)}:${line}`);
      }
    }
  }
  assert.deepEqual(found, [], `selectors after :global() are dropped by Vue:\n${found.join('\n')}`);
});
