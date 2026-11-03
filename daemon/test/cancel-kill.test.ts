// A cancel escalates to SIGKILL when the process group ignores SIGTERM.
import assert from 'node:assert/strict';
import { chmodSync, createWriteStream, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-test-'));
process.env.AGENTDECK_HOME = home;
const fake = join(import.meta.dirname, 'fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { runClaude, CANCEL_GRACE_MS } = await import('../src/adapters/claude.ts');

const run = (prompt: string, extra: { shouldCancel?: () => boolean; cancelGraceMs?: number }) =>
  runClaude({
    args: ['-p', prompt, '--output-format', 'stream-json'],
    cwd: home,
    log: createWriteStream(join(home, 'run.log')),
    ...extra,
  });

test('a cancel kills a group that ignores SIGTERM once the grace period is over', async () => {
  const started = Date.now();
  const r = await run('FAKE_SLOW FAKE_IGNORE_TERM', { shouldCancel: () => true, cancelGraceMs: 500 });
  const took = Date.now() - started;
  assert.ok(r.cancelled);
  // The cancel poll (2 s) plus the grace period plus a margin; the fake would sleep 30 s.
  assert.ok(took < 2_000 + 500 + 3_000, `ended in ${took} ms`);
});

test('the grace period is a named constant', () => {
  assert.equal(CANCEL_GRACE_MS, 10_000);
});

test('a run that exits on its own sends no SIGKILL later', async () => {
  const kills: unknown[] = [];
  const real = process.kill;
  process.kill = ((pid: number, sig?: string | number) => {
    if (sig === 'SIGKILL') kills.push(pid);
    return real(pid, sig as any);
  }) as typeof process.kill;
  try {
    // SIGTERM ends this one at once, so the timer must be cleared on close; wait past the grace period to see.
    const r = await run('FAKE_SLOW', { shouldCancel: () => true, cancelGraceMs: 300 });
    assert.ok(r.cancelled);
    await new Promise((res) => setTimeout(res, 800));
    assert.deepEqual(kills, []);
  } finally {
    process.kill = real;
  }
});
