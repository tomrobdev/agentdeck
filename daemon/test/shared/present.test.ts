// domain/shared/present: a value the code knows is there, checked in place of a non-null assertion.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { present } from '../../src/domain/shared/index.ts';

test('present: a value is returned as it is, 0 and the empty string included', () => {
  assert.equal(present(3, 'the count'), 3);
  assert.equal(present(0, 'the count'), 0);
  assert.equal(present('', 'the text'), '');
});

test('present: null or undefined throws, naming what was missing', () => {
  assert.throws(() => present(null, 'the repo'), /the repo is missing/);
  assert.throws(() => present(undefined, "#4's pull request"), /#4's pull request is missing/);
});
