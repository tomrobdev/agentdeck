// Pure tests of the shared text helpers and the stored form of a task's fields.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastLine, parseTextList, short, stored, textList, wholeNumberError } from '#domain/shared/index.ts';

test('wholeNumberError accepts a whole number in range and names the range otherwise', () => {
  assert.equal(wholeNumberError('max', 3, 1, 5), null);
  assert.equal(wholeNumberError('max', 1, 1, 5), null);
  assert.equal(wholeNumberError('max', 5, 1, 5), null);
  for (const bad of [0, 6, 2.5, '3', null, undefined, Number.NaN])
    assert.equal(wholeNumberError('max', bad, 1, 5), 'max must be a whole number from 1 to 5');
});

test('short keeps the first line of the trimmed text and cuts a long one with an ellipsis', () => {
  assert.equal(short('  hello\nworld ', 20), 'hello');
  assert.equal(short('abcdefghij', 5), 'abcd…');
  assert.equal(short('abcde', 5), 'abcde');
  assert.equal(short('', 5), '');
});

test('parseTextList reads a JSON list of strings, drops other items and falls back on bad input', () => {
  assert.deepEqual(parseTextList('["a","b",3]'), ['a', 'b']);
  assert.deepEqual(parseTextList('{"a":1}'), []);
  assert.deepEqual(parseTextList('not json', ['x']), ['x']);
  assert.deepEqual(parseTextList(null), []);
  assert.deepEqual(parseTextList(undefined, ['y']), ['y']);
});

test('textList splits a string on spaces and commas, trims, drops empties and repeats', () => {
  assert.deepEqual(textList('a, b  c,,a'), ['a', 'b', 'c']);
  assert.deepEqual(textList([' a ', '', 'b', 'a']), ['a', 'b']);
  assert.deepEqual(textList(''), []);
});

test('lastLine is the last non-empty line, trimmed and cut at 300 characters, or "no output"', () => {
  assert.equal(lastLine('one\n  two  \n\n'), 'two');
  assert.equal(lastLine('   \n'), 'no output');
  assert.equal(lastLine('x'.repeat(400)).length, 300);
});

test('stored turns the parsed fields back to JSON text and the flags to 1 or 0, and keeps other fields', () => {
  const out = stored({ id: 1, needs: [{ kind: 'deps' }], question: null, auto_merge: true, tests_passed: false });
  assert.deepEqual(out, { id: 1, needs: '[{"kind":"deps"}]', question: null, auto_merge: 1, tests_passed: 0 });
  assert.deepEqual(stored({ auto_merge: null, tests_passed: true, title: 't' }), { auto_merge: null, tests_passed: 1, title: 't' });
  assert.deepEqual(stored({ title: 'only' }), { title: 'only' });
});
