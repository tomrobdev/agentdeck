import assert from 'node:assert/strict';
import { test } from 'node:test';
import { highlightLines, languageFor } from '../../../../app/src/lib/shared/render.ts';

test('highlightLines gives one entry per line and escapes plain text', () => {
  assert.deepEqual(highlightLines(['a < b', 'c & d'], null), ['a &lt; b', 'c &amp; d']);
  assert.equal(highlightLines(['x', 'y', 'z'], 'typescript').length, 3);
});

test('highlightLines closes and reopens spans for a multi-line comment', () => {
  const lines = highlightLines(['/* one', ' two */', 'const a = 1;'], 'typescript');
  assert.equal(lines.length, 3);
  for (const line of lines) {
    const opens = (line.match(/<span/g) ?? []).length;
    const closes = (line.match(/<\/span>/g) ?? []).length;
    assert.equal(opens, closes, `balanced spans in ${line}`);
  }
  assert.match(lines[0], /^<span class="hljs-comment">\/\* one<\/span>$/);
  assert.match(lines[1], /^<span class="hljs-comment"> two \*\/<\/span>$/);
  assert.match(lines[2], /hljs-keyword/);
});

test('languageFor picks the language from the file name', () => {
  assert.equal(languageFor('src/a.ts'), 'typescript');
  assert.equal(languageFor('Dockerfile'), 'bash');
  assert.equal(languageFor('notes.txt'), null);
});
