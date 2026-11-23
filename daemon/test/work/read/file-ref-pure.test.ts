import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asRunId } from '#domain/shared/id.ts';
import { fileRefRun, isFileRef, verifyFileRef } from '#domain/work/index.ts';

test('a file ref is head, base or one verify run, never a commit or branch', () => {
  assert.equal(verifyFileRef(asRunId(7)), 'verify:7');
  assert.equal(fileRefRun('verify:7'), 7);
  for (const ref of ['head', 'base', 'verify:7']) assert.equal(isFileRef(ref), true, ref);
  for (const ref of ['verify:', 'verify:0', 'verify:7x', 'verify:HEAD', 'main', 'abc1234', '']) assert.equal(isFileRef(ref), false, ref);
});
