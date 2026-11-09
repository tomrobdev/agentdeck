// domain/text: the helpers shared by the daemon's wording.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cut, errorMessage, oneLine, plural } from '../../src/domain/shared/text.ts';

test('errorMessage: an Error gives its message, anything else its text', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom');
  assert.equal(errorMessage(new TypeError('bad')), 'bad');
  assert.equal(errorMessage('plain'), 'plain');
  assert.equal(errorMessage(undefined), 'undefined');
});

test('cut: a text within the limit is kept; a longer one ends in an ellipsis within the limit', () => {
  assert.equal(cut('abc', 3), 'abc');
  assert.equal(cut('abcd', 3), 'ab…');
  assert.equal(cut('abcd', 3).length, 3);
  assert.equal(cut('', 3), '');
});

test('oneLine: whitespace runs become one space and the ends are trimmed', () => {
  assert.equal(oneLine('  a\n\n b\t c  '), 'a b c');
});

test('plural: one takes the singular, any other count the plural', () => {
  assert.equal(plural(1, 'comment'), '1 comment');
  assert.equal(plural(2, 'comment'), '2 comments');
  assert.equal(plural(0, 'file'), '0 files');
});
