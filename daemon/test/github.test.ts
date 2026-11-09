// The github adapter's one gh() helper: errors say what went wrong without quoting the command line.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { github, failure } = await import('../src/adapters/github/github.ts');

/** Put a fake `gh` first on PATH that runs `script`. */
function fakeGh(script: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-gh-'));
  const bin = join(dir, 'gh');
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
}

test('a timed-out gh says so and does not quote its arguments', () => {
  // What execFile throws when its timeout kills the child: the message quotes the whole command line.
  const err = Object.assign(new Error('Command failed: gh pr create --title t --body SECRET-BODY'), {
    killed: true,
    signal: 'SIGTERM',
    code: null,
    stderr: '',
  });
  const { message } = failure(err);
  assert.equal(message, 'gh timed out after 30s');
  assert.doesNotMatch(message, /--body|SECRET/);
  assert.equal(failure(err, 'gh', 60_000).message, 'gh timed out after 60s');
});

test('a gh that fails without stderr reports its exit code, not the arguments', async () => {
  fakeGh('exit 3');
  await assert.rejects(
    github.createPr({ cwd: tmpdir(), base: 'main', head: 'feat', title: 'T', body: 'SECRET-BODY', draft: false }),
    (err: Error) => err.message === 'gh exited with code 3' && !/--body|SECRET/.test(err.message),
  );
});

test("a failing gh reports the first lines of its stderr, and auth() reports the last line of gh's output", async () => {
  fakeGh('echo "first line" >&2; echo "second line" >&2; echo "last line" >&2; exit 1');
  await assert.rejects(github.closePr('https://x/pull/1', tmpdir()), /^Error: first line second line last line$/);
  assert.deepEqual(await github.auth(), { ok: false, output: 'last line' });
});

test('auth() is ok when gh is logged in', async () => {
  fakeGh('echo "Logged in to github.com"');
  assert.deepEqual(await github.auth(), { ok: true, output: 'Logged in to github.com' });
});
