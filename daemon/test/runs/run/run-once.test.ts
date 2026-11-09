// `agentdeck run-once` has no API to claim the port, so it would run beside a live daemon, both following up the same
// outbox rows with a lock each. It asks first whether a daemon answers on the API port, and refuses to start if one does.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { runOnceRefusal } from '../../../src/domain/operations/index.ts';

const CLI = join(import.meta.dirname, '../../../src/cli.ts');
const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

test('runOnceRefusal: none when nothing answers; otherwise names the daemon and says to stop it', () => {
  assert.equal(runOnceRefusal(null, 4317), null);
  const cases: [Parameters<typeof runOnceRefusal>[0], RegExp][] = [
    [{ pid: 4242, commit: 'abc1234def5678' }, /daemon is running \(pid 4242, abc1234, on port 4317\)/],
    [{ pid: 7, commit: null }, /daemon is running \(pid 7, on port 4317\)/],
  ];
  for (const [running, expected] of cases) {
    const refusal = runOnceRefusal(running, 4317);
    assert.match(refusal ?? '', expected);
    assert.match(refusal ?? '', /stop it first \(`agentdeck service stop`\)/);
  }
});

/** A server on a port of its own that answers GET /api/daemon as a running daemon does. */
async function daemonAnswering(): Promise<number> {
  const state = { pid: 4242, commit: 'abc1234def5678', started_at: '2026-11-08T09:00:00Z', reload: { pending: false } };
  const s = createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(state)));
  servers.push(s);
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  return (s.address() as AddressInfo).port;
}

test('run-once with a daemon answering on the API port exits non-zero, naming it', async () => {
  const port = await daemonAnswering();
  const home = mkdtempSync(join(tmpdir(), 'agentdeck-run-once-'));
  const result = await new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve) => {
    execFile(
      process.execPath,
      [CLI, 'run-once'],
      { env: { ...process.env, AGENTDECK_HOME: home, AGENTDECK_PORT: String(port), AGENTDECK_NO_NOTIFY: '1' }, timeout: 30_000 },
      (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
  assert.notEqual(result.code, 0, `run-once started: ${result.stdout}`);
  assert.match(result.stderr, new RegExp(`daemon is running \\(pid 4242, abc1234, on port ${port}\\)`));
  assert.doesNotMatch(result.stdout, /agentdeck run-once/, 'the scheduler never started');
});
