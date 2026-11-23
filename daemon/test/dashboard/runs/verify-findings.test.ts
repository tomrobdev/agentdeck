import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findingFile, snippetOf, verdictCounts, verdictsShownFirst } from '#app/lib/runs/verify.ts';

const TEXT = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');

test('a snippet has the lines around its range and starts at the first of them', () => {
  assert.deepEqual(snippetOf(TEXT, { from: 10, to: 11 }, 1), { first: 9, text: 'line 9\nline 10\nline 11\nline 12' });
  assert.deepEqual(snippetOf(TEXT, { from: 1, to: 1 }, 2), { first: 1, text: 'line 1\nline 2\nline 3' });
  assert.equal(snippetOf(TEXT, { from: 21, to: 21 }), null, 'past the end');
});

test('the counts lead with the problems, and only problems show first unless every claim is true', () => {
  const of = (...verdicts: ('true' | 'false' | 'partly')[]) => verdicts.map((verdict) => ({ verdict }));
  assert.deepEqual(verdictCounts(of('true', 'partly', 'false', 'true')), [
    { verdict: 'false', count: 1 },
    { verdict: 'partly', count: 1 },
    { verdict: 'true', count: 2 },
  ]);
  assert.deepEqual(verdictsShownFirst(of('true', 'partly')), ['partly']);
  assert.deepEqual(verdictsShownFirst(of('true')), ['true']);
  assert.deepEqual(verdictsShownFirst([]), []);
});

test("a finding's file keeps its name and lines apart from its folder; a finding with none has no file", () => {
  assert.deepEqual(findingFile({ path: 'app/Services/A.php', line: 82, end_line: 89 }), {
    folder: 'app/Services/',
    name: 'A.php:82-89',
    range: { from: 82, to: 89 },
    query: { path: 'app/Services/A.php', L: '82-89' },
  });
  assert.equal(findingFile({ path: 'A.php', line: 3, end_line: null })?.name, 'A.php:3');
  assert.deepEqual(findingFile({ path: 'A.php', line: null, end_line: null }), {
    folder: '',
    name: 'A.php',
    range: null,
    query: { path: 'A.php' },
  });
  assert.equal(findingFile({ path: null, line: null, end_line: null }), null);
});
