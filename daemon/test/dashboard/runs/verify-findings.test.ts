import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snippetOf, verdictCounts, verdictsShownFirst } from '#app/lib/runs/verify.ts';

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
