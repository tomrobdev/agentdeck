// The issues adapter against a fake gh that records its arguments: the open-issue list and a close with its reason.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const bin = mkdtempSync(join(tmpdir(), 'agentdeck-gh-issues-'));
const argsFile = join(bin, 'args');
writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\necho '[]'\n`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;

const { githubIssues } = await import('#adapters/github/issues.ts');
const args = () => readFileSync(argsFile, 'utf8').trim().split('\n');

test('the poll lists every open issue at once, with the sub-issue count', async () => {
  assert.deepEqual(await githubIssues.openIssues(bin), []);
  const a = args();
  assert.deepEqual(a.slice(0, 4), ['issue', 'list', '--state', 'open']);
  assert.ok(!a.includes('--label'));
  assert.match(a.at(-1) ?? '', /subIssuesSummary/);
});

test('an issue is closed as completed or as not planned', async () => {
  await githubIssues.close(bin, 4, 'Merged.', 'completed');
  assert.deepEqual(args(), ['issue', 'close', '4', '--reason', 'completed', '--comment', 'Merged.']);
  await githubIssues.close(bin, 5, 'Rejected.', 'not_planned');
  assert.deepEqual(args(), ['issue', 'close', '5', '--reason', 'not planned', '--comment', 'Rejected.']);
});
