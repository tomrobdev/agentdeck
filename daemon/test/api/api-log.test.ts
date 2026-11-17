// What the API logs: one line per answered write with its status and time, the message of a failure, and never a body or a header.
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { BadRequest, dispatch, route } from '../../src/api/http.ts';

const lines: string[] = [];
const everything: string[] = [];
const token = 'secret-token-0123456789';
const routes = [
  route<unknown>('GET', /^\/api\/read$/, () => ({ ok: true })),
  route<unknown>('POST', /^\/api\/tasks\/(\d+)\/merge$/, () => ({ ok: true })),
  route('POST', /^\/api\/bad$/, () => {
    throw new BadRequest('title must be text');
  }),
  route('POST', /^\/api\/boom$/, () => {
    throw new Error('disk exploded');
  }),
];
const server = createServer(
  (req, res) =>
    void dispatch(routes, req, res, token, (line) => {
      lines.push(line);
      everything.push(line);
    }),
);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;
after(() => server.close());

function call(method: string, path: string, headers: Record<string, string>, body?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

test('a successful write logs one line with its method, path, status and time', async () => {
  lines.length = 0;
  assert.equal(await call('POST', '/api/tasks/12/merge', auth, '{"prompt":"private prompt"}'), 200);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /^api POST \/api\/tasks\/12\/merge 200 \d+\.\ds$/);
});

test('a 400 logs its message after the status', async () => {
  lines.length = 0;
  assert.equal(await call('POST', '/api/bad', auth, '{"plan":"private plan"}'), 400);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /^api POST \/api\/bad 400 \d+\.\ds title must be text$/);
});

test('a 500 logs the method, path and the error', async () => {
  lines.length = 0;
  assert.equal(await call('POST', '/api/boom', auth, '{}'), 500);
  assert.ok(lines.some((l) => l.startsWith('api POST /api/boom failed: Error: disk exploded')));
  assert.ok(lines.some((l) => /^api POST \/api\/boom 500 \d+\.\ds internal error$/.test(l)));
});

test('a read or a preflight logs nothing', async () => {
  lines.length = 0;
  assert.equal(await call('GET', '/api/read', {}), 200);
  assert.equal(await call('OPTIONS', '/api/read', {}), 204);
  assert.deepEqual(lines, []);
});

test('no logged line holds a body field or the token', async () => {
  const all = everything.join('\n');
  assert.ok(everything.length >= 4);
  assert.ok(!all.includes('private'));
  assert.ok(!all.includes(token));
  assert.ok(!/authorization|bearer/i.test(all));
});
