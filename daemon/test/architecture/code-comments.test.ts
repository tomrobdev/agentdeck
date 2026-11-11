// Code comments stay only where a tool reads them: a file's leading one-line comment, a reasoned @ts-expect-error, a reference directive and a migration's heading.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commentViolations, readViolations } from '../../scripts/lib/code-comments.ts';

test('[code-comments] daemon/src, app/src, daemon/test and daemon/scripts hold no code comment outside the allowed kinds', () => {
  const found = readViolations().map((v) => `${v.path}:${v.line} ${v.why} (rule code-comments): ${v.text.slice(0, 60)}`);
  assert.deepEqual(found, []);
});

test('[code-comments] a comment inside a function fails with its line, and the allowed kinds pass', () => {
  const bad = commentViolations(
    'daemon/src/x.ts',
    ['// What the file does.', 'export function f() {', '  // x', '  return 1;', '}', ''].join('\n'),
  );
  assert.deepEqual(
    bad.map((v) => [v.path, v.line]),
    [['daemon/src/x.ts', 3]],
  );
  const ok = ['// What the file does.', '// @ts-expect-error the type is wrong upstream', 'export const a: number = 1;', ''].join('\n');
  assert.deepEqual(commentViolations('daemon/test/x.ts', ok), []);
});

test('[code-comments] a second leading line, a block comment, a trailing comment and a bare @ts-expect-error fail', () => {
  const lines = ['// One.', '// Two.', '/* block */', 'export const a = 1; // trailing', '// @ts-expect-error', 'export const b = 2;', ''];
  assert.deepEqual(
    commentViolations('app/src/x.ts', lines.join('\n')).map((v) => v.line),
    [2, 3, 4, 5],
  );
});

test('[code-comments] a .vue template comment fails, and a script comment is found at its line', () => {
  const vue = [
    '<template>',
    '  <!-- note -->',
    '  <p>hi</p>',
    '</template>',
    '<script setup lang="ts">',
    'const a = 1;',
    '// why',
    '</script>',
    '',
  ].join('\n');
  assert.deepEqual(
    commentViolations('app/src/A.vue', vue).map((v) => v.line),
    [2, 7],
  );
});

test('[code-comments] a comment-like string, regex or template literal is not a comment', () => {
  const src = ['export const a = "// not";', 'export const b = /\\/\\//;', 'export const c = `/* no */ ${a}`;', ''].join('\n');
  assert.deepEqual(commentViolations('daemon/src/y.ts', src), []);
});

test('[code-comments] a migration step keeps its heading', () => {
  const src = ['export const MIGRATIONS = [', '  // 1: what it does.', '  () => 1,', '  () => {', '    // inside', '  },', '];', ''].join(
    '\n',
  );
  assert.deepEqual(
    commentViolations('daemon/src/db/schema.ts', src).map((v) => v.line),
    [5],
  );
});
