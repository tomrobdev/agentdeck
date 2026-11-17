// Who may call the API: a localhost Host header on every request, the API token on every write, and the token file itself.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-access-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('../fixtures/open-db.ts');
const { startApi } = await import('../../src/api/server.ts');
const { hasToken, isLocalHost } = await import('../../src/api/http.ts');
const { apiToken, bearer } = await import('../../src/config.ts');

const token = 'test-token-0123456789';
const server = await startApi({ db: openDb(join(home, 'test.db')), token, port: 0 });
const port = (server.address() as AddressInfo).port;
after(() => server.close());

function call(method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('a request whose Host is not localhost is refused, so a rebound DNS name reads nothing', async () => {
  for (const host of ['attacker.example:4317', 'attacker.example', '127.0.0.1.attacker.example:4317']) {
    const res = await call('GET', '/api/settings', { Host: host });
    assert.equal(res.status, 403, host);
    assert.match(res.body, /host not allowed/);
  }
  assert.equal((await call('GET', '/api/status', { Host: `localhost:${port}` })).status, 200);
  assert.equal((await call('GET', '/api/status')).status, 200);
});

test('reads need no token; writes do, from any client', async () => {
  assert.equal((await call('GET', '/api/settings')).status, 200);
  const none = await call('POST', '/api/pause');
  assert.equal(none.status, 401);
  assert.match(none.body, /API token/);
  assert.equal((await call('POST', '/api/pause', { Authorization: bearer('wrong') })).status, 401);
  assert.equal((await call('POST', '/api/pause', { Authorization: token })).status, 401);
  assert.equal((await call('DELETE', '/api/repos/1')).status, 401);
  assert.equal((await call('POST', '/api/resume', { Authorization: bearer(token) })).status, 200);
});

test('a preflight needs no token and lets the dashboard send it', async () => {
  const res = await new Promise<{ status: number; allow: string | undefined }>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method: 'OPTIONS', path: '/api/pause', headers: { Origin: 'tauri://localhost' } },
      (r) => {
        r.resume();
        resolve({ status: r.statusCode ?? 0, allow: r.headers['access-control-allow-headers'] as string | undefined });
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(res.status, 204);
  assert.match(res.allow ?? '', /Authorization/);
});

test('the host check reads only the name, with or without a port', () => {
  assert.ok(isLocalHost('127.0.0.1:4317') && isLocalHost('localhost') && isLocalHost('LOCALHOST:1') && isLocalHost('[::1]:4317'));
  assert.ok(!isLocalHost(undefined) && !isLocalHost('') && !isLocalHost('evil.example:4317') && !isLocalHost('localhost.evil.example'));
});

test('the token check wants the whole bearer value', () => {
  assert.ok(hasToken('Bearer abc', 'abc'));
  assert.ok(!hasToken(undefined, 'abc') && !hasToken('Bearer abcd', 'abc') && !hasToken('abc', 'abc') && !hasToken('Bearer ab', 'abc'));
});

test('the token file is made once, readable only by its owner, and kept', () => {
  const path = join(home, 'tokens', 'api-token');
  const first = apiToken(path, '');
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(apiToken(path, ''), first);
  assert.equal(readFileSync(path, 'utf8').trim(), first);
  writeFileSync(path, 'kept\n');
  assert.equal(apiToken(path, ''), 'kept');
  assert.equal(apiToken(path, 'from-env'), 'from-env');
});
