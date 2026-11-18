// The repo editor offers every PR mode the daemon accepts, each with a label and a title.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PR_MODE_OPTIONS } from '#app/lib/repos/repos-wording.ts';
import { PR_MODES } from '#domain/repos/index.ts';

test('the PR mode choices are the daemon PR modes, in order, each labelled', () => {
  assert.deepEqual(
    PR_MODE_OPTIONS.map((o) => o.value),
    PR_MODES,
  );
  for (const o of PR_MODE_OPTIONS) assert.ok(o.label && o.title);
});
