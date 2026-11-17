import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promiseCache } from '#application/shared/cache.ts';

function counted(): { make: (value: string) => () => Promise<string>; calls: () => number } {
  let calls = 0;
  return {
    make: (value) => () => {
      calls += 1;
      return Promise.resolve(value);
    },
    calls: () => calls,
  };
}

test('a cached key is made once', async () => {
  const cached = promiseCache<string>(2);
  const c = counted();
  assert.equal(await cached('a', c.make('A')), 'A');
  assert.equal(await cached('a', c.make('other')), 'A');
  assert.equal(c.calls(), 1);
});

test('past its size the least recently used key is dropped', async () => {
  const cached = promiseCache<string>(2);
  const c = counted();
  await cached('a', c.make('A'));
  await cached('b', c.make('B'));
  await cached('a', c.make('A'));
  await cached('c', c.make('C'));
  assert.equal(c.calls(), 3);
  await cached('a', c.make('A'));
  assert.equal(c.calls(), 3);
  await cached('b', c.make('B'));
  assert.equal(c.calls(), 4);
});

test('a failed result is forgotten, so the next call makes it again', async () => {
  const cached = promiseCache<string>(2);
  await assert.rejects(
    cached('a', () => Promise.reject(new Error('git failed'))),
    /git failed/,
  );
  assert.equal(await cached('a', () => Promise.resolve('A')), 'A');
});
