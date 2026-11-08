// Repo commands: their own process group, killed whole on timeout, and only the tail of a large output kept.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCommand } from '../src/adapters/shell.ts';
import { waitFor } from './fixtures.ts';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('a timeout kills the command and the children it started', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-shell-'));
  const pidFile = join(dir, 'child.pid');
  const result = await runCommand(`sleep 30 & echo $! > "${pidFile}"; wait`, dir, 500);
  assert.equal(result.passed, false);
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(pid > 0);
  await waitFor(() => !alive(pid), { timeoutMs: 1_000, what: `the child ${pid} to be gone` });
  assert.equal(alive(pid), false);
});

test('a passing command with more than 8 MB of output still passes, with the tail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-shell-'));
  const result = await runCommand(`head -c 10000000 /dev/zero | tr '\\0' x; echo; echo the-end`, dir, 60_000);
  assert.equal(result.passed, true);
  assert.ok(result.output.length <= 20_000);
  assert.ok(result.output.trimEnd().endsWith('the-end'));
});

test('a failing command reports its output, and a missing directory does not throw', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-shell-'));
  const failed = await runCommand('echo nope; exit 3', dir, 5_000);
  assert.equal(failed.passed, false);
  assert.match(failed.output, /nope/);
  const missing = await runCommand('true', join(dir, 'absent'), 5_000);
  assert.equal(missing.passed, false);
});
