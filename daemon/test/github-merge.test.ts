// The github adapter's merge, against a fake `gh` on PATH: the merge is pinned to the head it was decided on, and a
// refusal because the head moved comes back as an error mergeFailure reads as `head_moved`.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const bin = mkdtempSync(join(tmpdir(), 'agentdeck-gh-'));
const argsFile = join(bin, 'args');
// Writes its arguments one per line; fails as GitHub does when FAKE_GH_FAIL is set.
writeFileSync(
  join(bin, 'gh'),
  `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nif [ -n "$FAKE_GH_FAIL" ]; then echo "$FAKE_GH_FAIL" >&2; exit 1; fi\n`,
  { mode: 0o755 },
);
process.env.PATH = `${bin}:${process.env.PATH}`;

const { github } = await import('../src/adapters/github/github.ts');
const { mergeFailure } = await import('../src/domain/landing/merge/merge.ts');

const pr = { url: 'https://github.com/acme/demo/pull/7', cwd: bin, head: 'abc123' };

test('gh pr merge is pinned to the head with --match-head-commit, and a squash gets its message', async () => {
  delete process.env.FAKE_GH_FAIL;
  await github.merge({ ...pr, method: 'squash', message: { subject: 'Ship it', body: 'The body' } });
  assert.deepEqual(readFileSync(argsFile, 'utf8').trim().split('\n'), [
    'pr',
    'merge',
    pr.url,
    '--squash',
    '--match-head-commit',
    'abc123',
    '--subject',
    'Ship it',
    '--body',
    'The body',
  ]);
  await github.merge({ ...pr, method: 'rebase', message: { subject: 'x', body: 'y' } });
  assert.deepEqual(readFileSync(argsFile, 'utf8').trim().split('\n'), ['pr', 'merge', pr.url, '--rebase', '--match-head-commit', 'abc123']);
});

test('a merge GitHub refuses because the head moved fails with what mergeFailure reads as head_moved', async () => {
  process.env.FAKE_GH_FAIL = 'GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)';
  try {
    await assert.rejects(github.merge({ ...pr, method: 'merge' }), (err: Error) => mergeFailure(err.message) === 'head_moved');
  } finally {
    delete process.env.FAKE_GH_FAIL;
  }
});
